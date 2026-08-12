/**
 * CrewCoder as an ACP agent.
 *
 * Implements the agent half of the Agent Client Protocol so any ACP client
 * (CrewCode, Buzz, Zed) can drive CrewCoder over JSON-RPC on stdio. The agent
 * loop is already async and event-driven, so this is a translation layer: ACP
 * methods in, `AgentEvent`s out, `session/update` notifications back.
 */
import {
  PROTOCOL_VERSION,
  RequestError,
  type Agent,
  type AgentSideConnection,
  type AuthenticateRequest,
  type CancelNotification,
  type ContentBlock,
  type ClientCapabilities,
  type InitializeRequest,
  type InitializeResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type PermissionOption
} from "@agentclientprotocol/sdk";
import { runAgentLoop, type AgentLoopResult } from "../core/agent-loop.js";
import { runAgentLoopContinue } from "../core/agent-loop-continue.js";
import { createSessionId } from "../core/session-store.js";
import { setSessionExternalDirectories, validateExternalDirectories } from "../core/external-directories.js";
import { loadSession as loadSessionRecord } from "../core/session-loader.js";
import { getText } from "../core/messages.js";
import { readConfig } from "../core/config.js";
import { DEFAULT_AGENT_MODE } from "../core/mode-router.js";
import type { AgentEvent } from "../core/events.js";
import type { ApprovalMode } from "../core/approval.js";
import type { AgentMode } from "../core/types.js";
import type { ApprovalControlDecision } from "../core/stdin-control.js";
import { ProviderModelClient } from "../providers/provider-model-client.js";
import { listBuiltinProviderModels, resolveModel } from "../providers/model-registry.js";
import { createClientTextFileHost } from "./client-files.js";
import { translateEvent, type SessionUpdate } from "./event-translator.js";
import { toolKind, toolLocations, toolTitle } from "./tool-kind.js";

export type AcpAgentOptions = {
  /** Skips the real provider and uses the built-in heuristic client. Used by tests. */
  heuristic?: boolean;
  approvalMode?: ApprovalMode;
  mode?: AgentMode;
  /** Hard cap on model turns. 0/omitted means unlimited, per CrewCoder's default. */
  maxIterations?: number;
};

type AcpSession = {
  sessionId: string;
  cwd: string;
  providerId: string;
  model?: string;
  reasoningEffort?: string;
  mode: AgentMode;
  externalDirectories: string[];
  /** Set once the first prompt has run, so later turns resume from the store. */
  started: boolean;
  abort?: AbortController;
  cancelled: boolean;
  /** Tool call ids already announced to the client, to avoid duplicate rows. */
  announced: Set<string>;
  /** Instructions queued by session/follow_up while the agent loop is active. */
  followUpSignal: { messages: string[] };
};

/**
 * Model-picker shapes. The 1.x ACP schema dropped its model API, so these are
 * declared locally to match what clients still read off `session/new`.
 */
type AcpModelInfo = { modelId: string; name: string; description?: string };
type AcpModelState = { availableModels: AcpModelInfo[]; currentModelId: string };

const PERMISSION_OPTIONS: PermissionOption[] = [
  { optionId: "allow_once", name: "Allow", kind: "allow_once" },
  { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
  { optionId: "reject_once", name: "Reject", kind: "reject_once" },
  { optionId: "reject_always", name: "Always reject", kind: "reject_always" }
];

export class CrewCoderAcpAgent implements Agent {
  private readonly conn: AgentSideConnection;
  private readonly options: AcpAgentOptions;
  private readonly sessions = new Map<string, AcpSession>();
  private clientCapabilities: ClientCapabilities | undefined;
  /** Tools the user chose "always allow" for, per session. */
  private readonly alwaysAllow = new Map<string, Set<string>>();
  private readonly alwaysReject = new Map<string, Set<string>>();

  constructor(conn: AgentSideConnection, options: AcpAgentOptions = {}) {
    this.conn = conn;
    this.options = options;
  }

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    // Retained for the lifetime of the connection: file tools consult it on
    // every read/write to decide between the client filesystem and local disk.
    this.clientCapabilities = params.clientCapabilities;
    return {
      protocolVersion: Math.min(params.protocolVersion ?? PROTOCOL_VERSION, PROTOCOL_VERSION),
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          // CrewCoder takes images as on-disk paths, not inline base64, so the
          // ACP image block is not supported yet.
          image: false,
          audio: false,
          embeddedContext: false
        }
      },
      authMethods: []
    };
  }

  async authenticate(_params: AuthenticateRequest): Promise<void> {
    // Provider credentials are managed out of band by `crewcoder auth`, so
    // there is nothing to negotiate over ACP.
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const sessionId = createSessionId();
    const session = this.createSession(sessionId, params.cwd);
    // `models` is not in the 1.x ACP schema (the model API was removed), but
    // clients still read it off `session/new` to populate their model picker.
    // Emitting it is additive: clients that ignore it are unaffected.
    return { sessionId, models: this.modelState(session) } as NewSessionResponse;
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    const record = await loadSessionRecord(params.sessionId).catch(() => undefined);
    if (!record) throw RequestError.resourceNotFound(params.sessionId);

    const session = this.createSession(record.id, params.cwd, record.externalDirectories);
    // A loaded session already has a transcript, so the next prompt must
    // continue it rather than starting a fresh run.
    session.started = true;

    // ACP requires the agent to stream the restored conversation back as
    // notifications so the client can rebuild its transcript.
    for (const message of record.messages) {
      const text = getText(message).trim();
      if (!text) continue;
      if (message.role === "user") {
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: { sessionUpdate: "user_message_chunk", content: { type: "text", text } }
        });
      } else if (message.role === "assistant") {
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } }
        });
      }
    }

    return { models: this.modelState(session) } as LoadSessionResponse;
  }

  /**
   * `session/set_model` was removed from the 1.x ACP schema, so it arrives here
   * rather than as a typed method. Clients (including CrewCode) still call it,
   * and it is the only way to switch models without respawning the process.
   */
  async extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (method !== "session/set_model" && method !== "session/set_reasoning_effort" && method !== "session/set_external_directories" && method !== "session/follow_up") throw RequestError.methodNotFound(method);
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const session = this.session(sessionId);

    if (method === "session/follow_up") {
      const message = typeof params.message === "string" ? params.message.trim() : "";
      if (!message) throw RequestError.invalidParams({ reason: "message is required" });
      if (!session.abort) throw RequestError.invalidParams({ reason: "session is not running" });
      session.followUpSignal.messages.push(message);
      return { queued: true };
    }

    if (method === "session/set_reasoning_effort") {
      const effort = typeof params.effort === "string" ? params.effort.trim().toLowerCase() : "";
      if (!new Set(["none", "off", "low", "medium", "high", "xhigh", "max"]).has(effort)) {
        throw RequestError.invalidParams({ reason: "effort must be one of: off, low, medium, high, xhigh, max" });
      }
      session.reasoningEffort = effort === "off" ? "none" : effort;
      return {};
    }

    if (method === "session/set_external_directories") {
      if (!Array.isArray(params.directories) || !params.directories.every((directory) => typeof directory === "string")) {
        throw RequestError.invalidParams({ reason: "directories must be an array of paths" });
      }
      try {
        session.externalDirectories = session.started
          ? (await setSessionExternalDirectories(session.sessionId, params.directories)).externalDirectories ?? []
          : await validateExternalDirectories(session.cwd, params.directories);
      } catch (error) {
        throw RequestError.invalidParams({ reason: error instanceof Error ? error.message : String(error) });
      }
      return { externalDirectories: session.externalDirectories };
    }

    const modelId = typeof params.modelId === "string" ? params.modelId.trim() : "";
    if (!modelId) throw RequestError.invalidParams({ reason: "modelId is required" });

    // Model ids are `provider:model`. Model names contain colons of their own
    // (`qwen-2.5:free`), so split on the first one only.
    const separator = modelId.indexOf(":");
    if (separator > 0) {
      session.providerId = modelId.slice(0, separator);
      session.model = modelId.slice(separator + 1);
    } else {
      session.model = modelId;
    }
    return {};
  }

  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    if (!session) return;
    session.cancelled = true;
    session.abort?.abort();
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.session(params.sessionId);
    const prompt = promptText(params.prompt);
    if (!prompt) throw RequestError.invalidParams({ reason: "Prompt contained no text content" });

    const abort = new AbortController();
    session.abort = abort;
    session.cancelled = false;
    session.announced.clear();

    const approvalSignal = { decisions: [] as ApprovalControlDecision[] };
    const emit = async (event: AgentEvent): Promise<void> => {
      if (event.type === "approval_required") {
        approvalSignal.decisions.push(await this.resolveApproval(session, event));
        return;
      }
      if (event.type === "tool_execution_start") session.announced.add(event.toolCallId);
      const update = translateEvent(event);
      // ACP v1 has no standard compaction lifecycle update. CrewCoder's additive
      // namespaced kind is intentionally passed through for capable clients;
      // clients that only know the standard union ignore the unknown kind.
      if (update) await this.conn.sessionUpdate({ sessionId: session.sessionId, update: update as unknown as SessionUpdate });
    };

    const contextWindow = (await resolveModel(session.providerId, session.model))?.metadata?.contextWindow;
    const loopOptions = {
      providerId: session.providerId,
      model: session.model,
      contextWindow,
      approvalMode: this.options.approvalMode ?? ("review" as ApprovalMode),
      maxIterations: this.options.maxIterations,
      modelClient: this.options.heuristic
        ? undefined
        : new ProviderModelClient(session.providerId, session.cwd, session.model, undefined, session.reasoningEffort),
      approvalSignal,
      followUpSignal: session.followUpSignal,
      signal: abort.signal,
      textFiles: createClientTextFileHost(this.conn, session.sessionId, this.clientCapabilities),
      emit
    };

    let result: AgentLoopResult;
    try {
      result = session.started
        ? await runAgentLoopContinue({ sessionId: session.sessionId, prompt, mode: session.mode, cwd: session.cwd, externalDirectories: session.externalDirectories }, loopOptions)
        : await runAgentLoop(
            { prompt, requestedMode: session.mode, cwd: session.cwd, externalDirectories: session.externalDirectories },
            { ...loopOptions, sessionId: session.sessionId }
          );
    } catch (error) {
      if (session.cancelled) return { stopReason: "cancelled" };
      throw RequestError.internalError({ message: (error as Error).message });
    } finally {
      session.abort = undefined;
    }

    session.started = true;

    if (session.cancelled) return { stopReason: "cancelled" };
    // A provider failure is a failed turn, not a quiet `end_turn`. Surfacing it
    // as a JSON-RPC error is the only way the client renders it as an error.
    if (result.providerError) throw RequestError.internalError({ message: result.providerError });
    if (result.stallError) throw RequestError.internalError({ message: result.stallError });

    // Usage is reported twice on purpose. `_meta` is the spec-correct home and
    // carries the full summary (contextWindow, lastInputTokens, per-model
    // breakdown); the top-level `usage` mirror is what ACP clients written
    // against hermes already read, and its `inputTokens`/`outputTokens` names
    // line up with theirs.
    return {
      stopReason: stopReasonFor(result),
      usage: result.usage,
      _meta: { "crewcoder/usage": result.usage }
    } as PromptResponse;
  }

  private async resolveApproval(
    session: AcpSession,
    event: Extract<AgentEvent, { type: "approval_required" }>
  ): Promise<ApprovalControlDecision> {
    if (this.alwaysReject.get(session.sessionId)?.has(event.toolName)) {
      return { approvalId: event.approvalId, approved: false, reason: "Always reject was selected for this tool." };
    }
    if (this.alwaysAllow.get(session.sessionId)?.has(event.toolName)) {
      return { approvalId: event.approvalId, approved: true, reason: "Always allow was selected for this tool." };
    }

    // CrewCoder emits `approval_required` before `tool_execution_start`, so the
    // client has not seen this tool call yet. Announce it first or the
    // permission prompt refers to a row that does not exist.
    if (!session.announced.has(event.toolCallId)) {
      session.announced.add(event.toolCallId);
      await this.conn.sessionUpdate({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: event.toolCallId,
          title: toolTitle(event.toolName, event.args),
          kind: toolKind(event.toolName),
          status: "pending",
          rawInput: event.args,
          locations: toolLocations(event.args)
        }
      });
    }

    const response = await this.conn.requestPermission({
      sessionId: session.sessionId,
      options: PERMISSION_OPTIONS,
      toolCall: {
        toolCallId: event.toolCallId,
        title: toolTitle(event.toolName, event.args),
        kind: toolKind(event.toolName),
        status: "pending",
        rawInput: event.args
      }
    });

    if (response.outcome.outcome === "cancelled") {
      return { approvalId: event.approvalId, approved: false, reason: "Permission request cancelled." };
    }

    const optionId = response.outcome.optionId;
    // Match on prefix, not exact id: clients are known to answer with shortened
    // ids (CrewCode replies "reject") rather than echoing ours verbatim.
    const approved = optionId.startsWith("allow");
    if (optionId === "allow_always") this.remember(this.alwaysAllow, session.sessionId, event.toolName);
    if (optionId === "reject_always") this.remember(this.alwaysReject, session.sessionId, event.toolName);

    return { approvalId: event.approvalId, approved, reason: approved ? undefined : event.reason };
  }

  private remember(store: Map<string, Set<string>>, sessionId: string, toolName: string): void {
    const existing = store.get(sessionId) ?? new Set<string>();
    existing.add(toolName);
    store.set(sessionId, existing);
  }

  private session(sessionId: string): AcpSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw RequestError.invalidParams({ reason: `Unknown session: ${sessionId}` });
    return session;
  }

  private createSession(sessionId: string, cwd: string, externalDirectories: string[] = []): AcpSession {
    const config = readConfig();
    const session: AcpSession = {
      sessionId,
      cwd,
      providerId: process.env.CREWCODER_PROVIDER ?? config.defaultProvider,
      model: process.env.CREWCODER_MODEL ?? config.defaultModel,
      mode: this.options.mode ?? config.defaultMode ?? DEFAULT_AGENT_MODE,
      externalDirectories,
      started: false,
      cancelled: false,
      announced: new Set(),
      followUpSignal: { messages: [] }
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  /**
   * Built-in provider models as ACP `provider:model` choice ids. Clients group
   * the picker by the prefix, which is why CrewCoder presents as one provider
   * whose model list spans every configured backend.
   */
  private modelState(session: AcpSession): AcpModelState | undefined {
    const availableModels: AcpModelInfo[] = [];
    for (const entry of listBuiltinProviderModels()) {
      for (const name of entry.models) {
        availableModels.push({ modelId: `${entry.provider}:${name}`, name: `${entry.provider} / ${name}` });
      }
    }
    if (!availableModels.length) return undefined;
    const current = `${session.providerId}:${session.model ?? ""}`;
    return {
      availableModels,
      currentModelId: availableModels.some((entry) => entry.modelId === current) ? current : availableModels[0].modelId
    };
  }
}

function promptText(blocks: ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text") parts.push(block.text);
    else if (block.type === "resource_link") parts.push(block.uri);
    else if (block.type === "resource" && "text" in block.resource) parts.push(block.resource.text);
  }
  return parts.join("\n").trim();
}

function stopReasonFor(result: AgentLoopResult): PromptResponse["stopReason"] {
  if (result.approvalDenied) return "refusal";
  if (result.budgetExceeded) return "max_tokens";
  if (result.iterationCapReached) return "max_turn_requests";
  return "end_turn";
}
