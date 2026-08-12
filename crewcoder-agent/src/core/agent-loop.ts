import { resolveMode } from "./mode-router.js";
import { createStallDetector } from "./stall-detector.js";
import type { AgentRequest, ResolvedAgentMode } from "./types.js";
import type { AgentEvent, AgentEventSink } from "./events.js";
import type { AgentMessage, AssistantMessage, ToolCallPart, ToolResultMessage } from "./messages.js";
import { getText, renderMessagesForModel, textMessage, withImageParts } from "./messages.js";
import type { TextFileHost, ToolContext, ToolDefinition } from "./tool-types.js";
import { createToolRegistry, findTool } from "../tools/index.js";
import { resolveIntegrationProfile, type IntegrationProfile } from "./integration-profile.js";
import { crewcodeSkills } from "../skills/crewcode/index.js";
import { crewcoderExtensionSkills } from "../skills/crewcoder-extension/index.js";
import type { Skill } from "../skills/types.js";
import { activateEnabledExtensions, formatExtensionActivation, activatedContributionIds } from "../extensions/extension-activation.js";
import { loadTrustedExtensionTools } from "../extensions/extension-tools.js";
import { collectExtensionContext, loadTrustedExtensionHooks, runAfterToolHooks, runBeforeToolHooks, runCompactionHooks, runErrorHooks, type LoadedExtensionHook } from "../extensions/extension-hooks.js";
import { loadTrustedExtensionFileTriggers, runExtensionFileTriggers, type LoadedExtensionFileTrigger } from "../extensions/extension-file-triggers.js";
import { evaluateExtensionApprovalPolicies, loadTrustedExtensionApprovalPolicies, type LoadedExtensionApprovalPolicy } from "../extensions/extension-approval-policies.js";
import { collectContextEventResults, emitCrewCoderExtensionEvent, loadTrustedCrewCoderExtensionRuntime, normalizeBeforeToolEventResults, seedCrewCoderExtensionEntries, type LoadedCrewCoderExtensionRuntime } from "../extensions/extension-runtime.js";
import type { CrewCoderExtSessionEntry } from "../extensions/api.js";
import type { ExtensionUiBridge } from "./extension-ui-bridge.js";
import { embeddedCrewCodeDocs, type EmbeddedDoc } from "../knowledge/crewcode-docs.js";
import { embeddedCrewCoderExtensionDocs } from "../knowledge/crewcoder-extension-docs.js";
import { appendCustomSystemPrompt, buildSystemPrompt } from "./system-prompt.js";
import { getSystemPrompt } from "./system-prompt-store.js";
import { createModelClientFromEnv, type ModelClient } from "./model-client.js";
import { createSessionId, saveSession, type SessionModelTurn } from "./session-store.js";
import { assignAssistantHashes } from "./message-hash.js";
import { decideApproval, type ApprovalMode } from "./approval.js";
import { buildSandboxContext } from "./sandbox.js";
import { addUsage, currentContextTokens, emptyUsageSummary, type ModelUsage, type UsageSummary } from "./usage.js";
import { tokenBudgetStatus } from "./token-budget.js";
import { loadVerificationChecks, runVerificationChecks, type VerificationResult } from "./verification.js";
import { inspectProject, formatProjectInspection, type ProjectInspection } from "./repo-inspector.js";
import { prepareLiveCompaction, applyCompactionProposal, summarizeMessagesForHandoff, type SessionCompaction } from "./session-compaction.js";
import { createSessionCheckpoint, MAX_SESSION_CHECKPOINTS, type SessionCheckpoint } from "./session-checkpoints.js";
import { readConfig } from "./config.js";
import { resolveActiveWorker, buildIdentityPrompt } from "./identity.js";
import { dumpModelInput } from "./model-input-dump.js";
import { appendAuditLog } from "./audit-log.js";
import { recordModelUsageCost } from "./cost-ledger.js";
import { readCrewTasksConfig } from "../crew-tasks/config.js";
import { readMemoryContext } from "./memory-store.js";
import { readRulesContext } from "./rules-store.js";
import { formatExternalDirectories, validateExternalDirectories } from "./external-directories.js";
import type { ApprovalControlDecision, CompactionPreviewDecision } from "./stdin-control.js";

export type AgentLoopOptions = {
  modelClient?: ModelClient;
  tools?: ToolDefinition[];
  /** Extra host-owned tools added without replacing built-ins or trusted extension tools. */
  additionalTools?: ToolDefinition[];
  /** Explicit host override; normal CLI/TUI runs resolve repository then user profile. */
  integrationProfile?: IntegrationProfile;
  /** Hard cap on model turns. 0 or omitted means unlimited (config `maxIterations`). */
  maxIterations?: number;
  /** Overrides config `stallDetection`. Defaults on; only trips on provable loops. */
  stallDetection?: boolean;
  emit?: AgentEventSink;
  signal?: AbortSignal;
  providerId?: string;
  model?: string;
  /**
   * Reasoning effort of this run. The model client already has it; the loop
   * carries it only so the durable session can restore it on resume.
   */
  effort?: string;
  /** Active model's context-window size, surfaced on every usage_update summary. */
  contextWindow?: number;
  approvalMode?: ApprovalMode;
  /** Host-provided text file I/O for read/write/edit. Defaults to local disk. */
  textFiles?: TextFileHost;
  sessionId?: string;
  resumeFromSessionId?: string;
  /** Audit-only parent for a fresh summary handoff; does not inherit transcript. */
  parentSessionId?: string;
  initialMessages?: AgentMessage[];
  initialMutationLog?: string[];
  initialUsage?: UsageSummary;
  initialCompactions?: SessionCompaction[];
  initialCheckpoints?: SessionCheckpoint[];
  initialModelTurns?: SessionModelTurn[];
  initialProviderSessionIds?: Record<string, string>;
  initialExtensionEntries?: CrewCoderExtSessionEntry[];
  resumeContext?: string;
  dumpModelInput?: boolean;
  systemPromptName?: string;
  workerName?: string;
  workerDelegationDepth?: number;
  maxChildWorkerDepth?: number;
  autoCompact?: boolean;
  autoCompactThresholdTokens?: number;
  /**
   * When true (and a `compactionPreviewSignal` is wired), live compaction pauses
   * to emit a `session_compaction_preview` event and waits for a host decision
   * before installing the summary. Falls back to config `compactionPreview`.
   */
  compactionPreview?: boolean;
  /**
   * Mutable queue for compaction-preview decisions sent through the stdin control
   * channel. Required for the preview pause to actually block; without it the
   * loop compacts immediately even when preview is enabled.
   */
  compactionPreviewSignal?: { decisions: CompactionPreviewDecision[] };
  /** Cumulative token ceiling for this durable session. Inherited on resume. */
  tokenBudget?: number;
  /** Run post-agent typecheck/test and trusted extension validators. */
  verify?: boolean;
  /** Persist the session to CrewCoder's durable store. Defaults to true. */
  persistSession?: boolean;
  /**
   * Mutable flag for user-triggered mid-run compaction. Set `.requested = true`
   * from a stdin control listener; the loop consumes it at the next safe point
   * (between iterations) and forces a compaction regardless of the token threshold.
   */
  manualCompactSignal?: { requested: boolean; preview?: boolean };
  /**
   * Mutable queue for user follow-ups sent while a JSON-events run is active.
   * The loop drains it only at safe points between provider/tool steps so the
   * active provider request is never interrupted.
   */
  followUpSignal?: { messages: string[] };
  /**
   * Mutable queue for user approval decisions sent through the stdin control
   * channel while a JSON-events run is active.
   */
  approvalSignal?: { decisions: ApprovalControlDecision[] };
  /**
   * Host-owned UI bridge. When provided (interactive TUI / JSON-events host),
   * extension `ctx.ui.*` calls route to the host via `extension_ui_*` events and
   * `ui_response` control messages. When omitted, extensions get the safe no-op
   * UI fallback so non-interactive runs never block.
   */
  uiBridge?: ExtensionUiBridge;
};

export type AgentLoopResult = {
  sessionId: string;
  mode: ResolvedAgentMode;
  providerId?: string;
  model?: string;
  messages: AgentMessage[];
  activatedSkills: string[];
  activatedExtensions: string[];
  retrievedDocs: string[];
  mutationLog: string[];
  externalDirectories?: string[];
  usage: UsageSummary;
  project: ProjectInspection;
  compactions: SessionCompaction[];
  checkpoints: SessionCheckpoint[];
  modelTurns: SessionModelTurn[];
  providerSessionIds?: Record<string, string>;
  extensionEntries?: CrewCoderExtSessionEntry[];
  sessionFile?: string;
  summary: string;
  notes: string[];
  budgetExceeded: boolean;
  /** Set when the provider failed (auth, billing, network). Callers must treat the run as failed. */
  providerError?: string;
  /** Set when the run was stopped because it was provably looping. */
  stallError?: string;
  /** Set when an explicit maxIterations cap truncated the run before the task finished. */
  iterationCapReached?: boolean;
  /** Set when an interactive or non-interactive approval gate denied a requested tool call. */
  approvalDenied?: { approvalId: string; toolCallId?: string; toolName?: string; reason?: string };
  verification?: { ok: boolean; checks: VerificationResult[] };
};

export async function runAgentLoop(request: AgentRequest, options: AgentLoopOptions = {}): Promise<AgentLoopResult> {
  const sessionId = options.sessionId ?? createSessionId();
  const runtimeConfig = readConfig();
  const integrationProfile = options.integrationProfile ?? resolveIntegrationProfile(request.cwd, runtimeConfig);
  const mode = resolveMode(request.requestedMode);
  if (mode === "plugin" && integrationProfile !== "crewcode") {
    throw new Error("CrewCode plugin mode is disabled in the standalone profile. Enable it with: crewcoder profile use crewcode --project");
  }
  const project = await inspectProject(request.cwd);
  const externalDirectories = await validateExternalDirectories(request.cwd, request.externalDirectories);
  const projectContext = formatProjectInspection(project);
  const initialMessages = options.initialMessages ?? [];
  const compactions: SessionCompaction[] = [...(options.initialCompactions ?? [])];
  const checkpoints: SessionCheckpoint[] = [...(options.initialCheckpoints ?? [])]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .slice(-MAX_SESSION_CHECKPOINTS);
  const modelTurns: SessionModelTurn[] = [...(options.initialModelTurns ?? [])];
  const providerSessionIds = { ...(options.initialProviderSessionIds ?? {}) };
  const activeWorker = resolveActiveWorker(options.workerName);
  const newUserMessage = withImageParts(textMessage("user", request.prompt), request.images ?? []);
  if (!options.resumeFromSessionId) {
    const contextRoot = project.repoRoot ?? request.cwd;
    const memoryContext = readMemoryContext(contextRoot);
    const rulesContext = readRulesContext(contextRoot);
    newUserMessage.background = [
      ...(options.resumeContext ? [options.resumeContext] : []),
      ...(rulesContext ? [rulesContext] : []),
      ...(memoryContext ? [memoryContext] : []),
      projectContext,
    ];
  }
  let messages: AgentMessage[] = [...initialMessages, newUserMessage];
  const startedAt = new Date().toISOString();
  const events: AgentEvent[] = [];
  const mutationLog: string[] = [...(options.initialMutationLog ?? [])];
  let usageSummary = options.initialUsage ?? emptyUsageSummary();
  const tokenBudget = options.tokenBudget ?? usageSummary.tokenBudget;
  if (typeof options.contextWindow === "number") usageSummary = { ...usageSummary, contextWindow: options.contextWindow };
  if (typeof tokenBudget === "number") usageSummary = { ...usageSummary, tokenBudget };
  let budgetWarningEmitted = typeof tokenBudget === "number" && tokenBudgetStatus(usageSummary, tokenBudget).warningReached;
  let budgetDownshiftRequested = false;
  let budgetExceeded = typeof tokenBudget === "number" && tokenBudgetStatus(usageSummary, tokenBudget).exceeded;
  const builtInTools = options.tools ?? createToolRegistry(integrationProfile, mode);
  const tools = options.tools
    ? [...builtInTools, ...(options.additionalTools ?? [])]
    : [...builtInTools, ...(await loadTrustedExtensionTools()), ...(options.additionalTools ?? [])];
  const modelClient = options.modelClient ?? createModelClientFromEnv();
  const approvalMode = options.approvalMode ?? "never";
  // 0/undefined means unlimited. A working agent is bounded by the task, by an
  // opt-in token budget, or by stall detection — never by a turn counter.
  const requestedIterations = options.maxIterations ?? runtimeConfig.maxIterations;
  const maxIterations = requestedIterations > 0 ? requestedIterations : Number.POSITIVE_INFINITY;
  const stallDetector = (options.stallDetection ?? runtimeConfig.stallDetection)
    ? createStallDetector({ repeatThreshold: runtimeConfig.stallRepeatThreshold, errorThreshold: runtimeConfig.stallErrorThreshold })
    : undefined;
  const extensionRuntime = await loadTrustedCrewCoderExtensionRuntime();
  const priorExtensionEntries = options.initialExtensionEntries ?? [];
  seedCrewCoderExtensionEntries(extensionRuntime, priorExtensionEntries);
  // Entries appended during this run start after the replayed history. Capturing
  // the index avoids leaking entries across sessions when a cached runtime
  // singleton is reused for multiple loops in the same process.
  const runEntriesStart = extensionRuntime.entries.length;
  const extensionHooks = await loadTrustedExtensionHooks();
  const extensionFileTriggers = await loadTrustedExtensionFileTriggers();
  const extensionApprovalPolicies = await loadTrustedExtensionApprovalPolicies();
  const checkpointsEnabled = runtimeConfig.checkpointsEnabled;
  const autoCompactEnabled = options.autoCompact ?? runtimeConfig.autoCompact;
  const configuredCompactThreshold = options.autoCompactThresholdTokens ?? runtimeConfig.autoCompactThresholdTokens;
  // Normal automatic compaction leaves 40% headroom. If the user explicitly turns it
  // off, retain an 80% emergency boundary so no known provider context is allowed to
  // grow unchecked. The configured absolute threshold can only make auto-compaction earlier.
  const contextCompactThreshold = typeof options.contextWindow === "number"
    ? Math.floor(options.contextWindow * (autoCompactEnabled ? 0.6 : 0.8))
    : undefined;
  const autoCompactThreshold = autoCompactEnabled
    ? Math.min(configuredCompactThreshold, contextCompactThreshold ?? Number.POSITIVE_INFINITY)
    : contextCompactThreshold;
  const compactionPreviewSignal = options.compactionPreviewSignal;
  const compactionPreviewEnabled = Boolean(compactionPreviewSignal) && (options.compactionPreview ?? runtimeConfig.compactionPreview);
  const approvalAuditContexts = new Map<string, { toolCallId: string; toolName: string; args: Record<string, unknown>; risk: string }>();
  let approvalDenied: AgentLoopResult["approvalDenied"];

  const emit = async (event: AgentEvent) => {
    if (event.type === "approval_resolved" && !event.approved) {
      const approval = approvalAuditContexts.get(event.approvalId);
      approvalDenied = {
        approvalId: event.approvalId,
        toolCallId: approval?.toolCallId,
        toolName: approval?.toolName,
        reason: event.reason
      };
    }
    await appendAuditEvent(event, { cwd: request.cwd, sessionId, approvals: approvalAuditContexts });
    events.push(event);
    await options.emit?.(event);
    await emitCrewCoderExtensionEvent(extensionRuntime, "agent_event", event, { cwd: request.cwd, sessionId, mode: options.uiBridge ? "tui" : "print", signal: options.signal }, options.uiBridge);
  };

  const skills = selectSkills(mode, request.prompt);
  const docs = selectDocs(mode);
  const crewTasksConfig = readCrewTasksConfig();
  const crewTasksPrompt = crewTasksConfig.enabled
    ? [
        "crew-tasks is enabled for this project/session.",
        "For complex multi-step work, use TaskCreate/TaskList/TaskGet/TaskUpdate to maintain persistent project tasks in .crewcoder/tasks.",
        "Treat these persistent tasks as the agent todo integration: create tasks for durable work, set in_progress before starting, and set completed only when fully done."
      ].join("\n")
    : null;
  const extensionActivation = await activateEnabledExtensions(request.prompt);
  const hookContexts = await collectExtensionContext(extensionHooks, { cwd: request.cwd, sessionId, prompt: request.prompt, mode });
  const apiContextResults = await emitCrewCoderExtensionEvent(extensionRuntime, "context", { cwd: request.cwd, sessionId, prompt: request.prompt, mode }, { cwd: request.cwd, sessionId }, options.uiBridge);
  const apiContexts = collectContextEventResults(apiContextResults).map((context, index) => `[CrewCoderExtAPI/context/${index + 1}]\n${context}`);
  const extensionContext = [formatExtensionActivation(extensionActivation), hookContexts.length || apiContexts.length ? ["Trusted extension context hooks:", ...hookContexts, ...apiContexts].join("\n") : ""].filter(Boolean).join("\n\n");
  const activatedExtensions = activatedContributionIds(extensionActivation);
  const selectedSystemPromptName = options.systemPromptName;
  const selectedSystemPrompt = selectedSystemPromptName ? getSystemPrompt(selectedSystemPromptName) : null;
  const defaultSystemPrompt = [
    buildSystemPrompt({ mode, skills, docs, identityPrompt: buildIdentityPrompt(activeWorker), crewTasksPrompt, extensionContext }),
    formatExternalDirectories(externalDirectories)
  ].filter(Boolean).join("\n\n");
  const systemPrompt = appendCustomSystemPrompt(defaultSystemPrompt, selectedSystemPrompt?.content);
  const sandbox = buildSandboxContext(approvalMode, request.cwd, externalDirectories);
  const workerDelegationDepth = options.workerDelegationDepth ?? 0;
  const maxChildWorkerDepth = options.maxChildWorkerDepth ?? 1;
  const toolContext: ToolContext = {
    cwd: request.cwd,
    externalDirectories,
    mode,
    integrationProfile,
    sessionId,
    mutationLog,
    sandbox,
    emit,
    textFiles: options.textFiles,
    delegateWorker: workerDelegationDepth < maxChildWorkerDepth ? async (delegation, signal) => {
      const childPrompt = [
        `Parent worker ${activeWorker.name} delegated this scoped subtask from session ${sessionId}.`,
        "Return a concise summary of findings/actions for the parent worker.",
        "",
        delegation.task
      ].join("\n");
      const child = await runAgentLoop({ prompt: childPrompt, requestedMode: mode, cwd: request.cwd, externalDirectories }, {
        providerId: options.providerId,
        model: options.model,
        contextWindow: options.contextWindow,
        approvalMode,
        modelClient,
        // Unlimited unless the parent explicitly caps it. Child workers are
        // bounded by stall detection and maxChildWorkerDepth, not a turn count.
        maxIterations: delegation.maxIterations,
        workerName: delegation.worker,
        resumeFromSessionId: sessionId,
        initialMessages: messages,
        initialMutationLog: mutationLog,
        workerDelegationDepth: workerDelegationDepth + 1,
        maxChildWorkerDepth,
        signal,
        uiBridge: options.uiBridge,
        emit: options.emit
      });
      return { worker: delegation.worker, sessionId: child.sessionId, summary: child.summary, mutationLog: child.mutationLog };
    } : undefined
  };

  await emitCrewCoderExtensionEvent(extensionRuntime, "session_start", { reason: "startup", cwd: request.cwd, sessionId }, { cwd: request.cwd, sessionId }, options.uiBridge);
  await emit({ type: "agent_start", sessionId });
  await emit({ type: "extension_safety_policies", policies: extensionApprovalPolicies });
  await emit({ type: "message_start", message: newUserMessage });
  await emit({ type: "message_end", message: newUserMessage });

  const drainFollowUps = async (): Promise<number> => {
    const queued = options.followUpSignal?.messages.splice(0) ?? [];
    for (const text of queued) {
      const followUp = textMessage("user", text);
      followUp.background = ["Follow-up queued during the active run. Treat this as additional user context for the current task."];
      messages.push(followUp);
      await emit({ type: "message_start", message: followUp });
      await emit({ type: "message_end", message: followUp });
    }
    return queued.length;
  };

  /**
   * Snapshot of everything durable about this run so far.
   *
   * Called after every completed turn, not only at the end. The JSONL store is
   * append-only and delta-based, so a save writes just what is new (measured
   * ~2ms/save, ~255ms across a 120-turn session). Saving only at the end meant a
   * killed, crashed, or provider-failed run lost its entire transcript, including
   * tool results for files it had already changed on disk.
   */
  const persistCurrentSession = async (): Promise<string | undefined> => {
    if (options.persistSession === false) return undefined;
    return saveSession({
      id: sessionId,
      startedAt,
      cwd: request.cwd,
      externalDirectories,
      requestedMode: request.requestedMode,
      resolvedMode: mode,
      prompt: request.prompt,
      provider: options.providerId,
      model: options.model,
      effort: options.effort,
      events,
      messages,
      modelTurns,
      providerSessionIds,
      mutationLog,
      usage: usageSummary,
      compactions,
      checkpoints,
      extensionState: {},
      extensionEntries: [...priorExtensionEntries, ...extensionRuntime.entries.slice(runEntriesStart)],
      parentSessionId: options.parentSessionId ?? (options.resumeFromSessionId && options.resumeFromSessionId !== sessionId ? options.resumeFromSessionId : undefined),
      systemPrompt: selectedSystemPrompt ? { name: selectedSystemPrompt.name, path: selectedSystemPrompt.path } : undefined
    });
  };

  /**
   * Mid-run checkpoint of the transcript. Best-effort by design: a failed
   * incremental save degrades to a debug warning, because losing durability is
   * bad but killing a working run over it is worse. The final save still reports
   * failures normally.
   */
  const persistTurn = async (iteration: number): Promise<void> => {
    try {
      await persistCurrentSession();
    } catch (error) {
      await emit({ type: "backend_debug", timestamp: new Date().toISOString(), level: "warn", source: "session-store", message: "incremental session save failed", details: { iteration, error: error instanceof Error ? error.message : String(error) } });
    }
  };

  // Every billed model turn is appended to the cost ledger and the resolved
  // dollar figure rides along on the usage summary. A ledger failure degrades to
  // a debug warning: accounting must never be able to kill a working run.
  const priceTurn = async (usage: ModelUsage): Promise<ModelUsage> => {
    const { entry, error } = await recordModelUsageCost(usage, { sessionId, worker: activeWorker.name, cwd: request.cwd });
    if (error) {
      await emit({ type: "backend_debug", timestamp: new Date().toISOString(), level: "warn", source: "cost-ledger", message: "cost ledger write failed", details: { error } });
      return usage;
    }
    return typeof entry?.costUsd === "number" ? { ...usage, costUsd: entry.costUsd } : usage;
  };

  let finalAssistant: AssistantMessage | undefined;
  let providerError: string | undefined;
  let stallError: string | undefined;
  let iterationCapReached = false;

  // Resumed sessions commonly perform one conversational model turn per process. The
  // between-tool check below is never reached in that shape, so compact before the first
  // provider request when persisted usage already shows dangerous context occupancy.
  if (autoCompactThreshold !== undefined && currentContextTokens(usageSummary) >= autoCompactThreshold && messages.length > 14) {
    const proposal = await prepareLiveCompaction(messages, { modelClient, signal: options.signal });
    if (proposal) {
      const applied = applyCompactionProposal(proposal, { note: "This synthetic message preserves older session context after preflight safety compaction." });
      messages = applied.messages;
      compactions.push(applied.compaction);
      for (const providerId of Object.keys(providerSessionIds)) delete providerSessionIds[providerId];
      await modelClient.resetSessionContinuation?.(sessionId);
      usageSummary = { ...usageSummary, lastInputTokens: 0 };
      await emit({
        type: "session_compacted",
        compactionId: applied.compaction.id,
        originalMessageCount: applied.compaction.originalMessageCount,
        retainedMessageCount: applied.compaction.retainedMessageCount,
        summary: applied.compaction.summary
      });
    }
  }

  try {
    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      if (options.signal?.aborted) break;

      await drainFollowUps();
      await emit({ type: "turn_start", iteration });
      if (budgetExceeded && typeof tokenBudget === "number") {
        const status = tokenBudgetStatus(usageSummary, tokenBudget);
        await emit({ type: "token_budget_exceeded", sessionId, limit: status.limit, used: status.used, percent: status.percent, handoffSummary: summarizeMessagesForHandoff(messages) });
        const capped: AssistantMessage = { role: "assistant", content: [{ type: "text", text: `Token budget reached (${status.used.toLocaleString("en-US")}/${status.limit.toLocaleString("en-US")}). Start or resume with a larger --budget to continue.` }], stopReason: "end", timestamp: Date.now() };
        messages.push(capped);
        finalAssistant = capped;
        await emit({ type: "message_start", message: capped });
        await emit({ type: "message_end", message: capped });
        await emit({ type: "turn_end", iteration, message: capped, toolResults: [] });
        break;
      }
      if (options.providerId) await emit({ type: "provider_start", providerId: options.providerId, model: options.model });

      let streamedAssistantText = false;
      let turnUsage: ModelUsage | undefined;
      let assistant: AssistantMessage;
      let generationDurationMs: number | undefined;
      try {
        const modelInput = {
          systemPrompt,
          messages: renderMessagesForModel(messages),
          externalDirectories,
          // Provider-native filesystem tools cannot honor ACP/SDK virtual file hosts.
          useProviderNativeFileTools: options.textFiles === undefined,
          availableTools: tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
          session: { sessionId, resumeFromSessionId: options.resumeFromSessionId, continuation: Boolean(options.initialMessages?.length), providerSessionId: options.providerId ? providerSessionIds[options.providerId] : undefined }
        };
        if (options.dumpModelInput) {
          const dumpPath = await dumpModelInput(modelInput, { sessionId, iteration, providerId: options.providerId, model: options.model });
          await emit({ type: "backend_debug", timestamp: new Date().toISOString(), level: "info", source: "agent-loop", message: "model input dumped", details: { path: dumpPath, iteration, providerId: options.providerId, model: options.model } });
        }
        const generationStartedAt = performance.now();
        assistant = await modelClient.complete(modelInput, options.signal, {
          async onAssistantDelta(text) {
            streamedAssistantText = true;
            await emit({ type: "assistant_delta", text });
          },
          async onThinkingDelta(text) {
            await emit({ type: "thinking_delta", text });
          },
          async onProviderSessionId(providerSessionId) {
            if (options.providerId) providerSessionIds[options.providerId] = providerSessionId;
          },
          async onProviderToolStart(call) {
            await emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments });
          },
          async onProviderToolEnd(result) {
            const message: ToolResultMessage = { role: "toolResult", toolCallId: result.toolCallId, toolName: result.toolName, content: [{ type: "text", text: result.text }], isError: result.isError, timestamp: Date.now() };
            await emit({ type: "tool_execution_end", toolCallId: result.toolCallId, toolName: result.toolName, result: message, isError: result.isError });
          },
          async executeTool(call) {
            const [result] = await executeToolCalls([call], tools, toolContext, emit, approvalMode, extensionHooks, extensionFileTriggers, extensionApprovalPolicies, extensionRuntime, checkpoints, checkpointsEnabled, options.signal, options.approvalSignal, options.uiBridge);
            return result ?? { role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: `Tool ${call.name} did not return a result.` }], isError: true, timestamp: Date.now() };
          },
          async requestQuestion(question) {
            if (!options.uiBridge) return undefined;
            const ui = options.uiBridge.uiFor("claude-sdk");
            return question.options?.length
              ? await ui.select(question.title, question.options)
              : await ui.input(question.title, { placeholder: question.placeholder });
          },
          async onUsage(reportedUsage) {
            const usage = await priceTurn(reportedUsage);
            turnUsage = usage;
            usageSummary = addUsage(usageSummary, usage);
            if (typeof tokenBudget === "number") {
              const status = tokenBudgetStatus(usageSummary, tokenBudget);
              budgetExceeded = status.exceeded;
              usageSummary = { ...usageSummary, tokenBudget, budgetExceeded };
              await emit({ type: "usage_update", usage, summary: usageSummary });
              if (!budgetWarningEmitted && status.warningReached) {
                budgetWarningEmitted = true;
                budgetDownshiftRequested = !status.exceeded;
                await emit({ type: "token_budget_warning", limit: status.limit, used: status.used, remaining: status.remaining, percent: status.percent });
              }
              return;
            }
            await emit({ type: "usage_update", usage, summary: usageSummary });
          }
        });
        generationDurationMs = performance.now() - generationStartedAt;
        assistant = assignAssistantHashes(assistant, modelInput);
        modelTurns.push({ iteration, input: modelInput, promptHash: assistant.promptHash ?? "", responseHash: assistant.responseHash ?? "", responseId: assistant.id ?? "" });
      } catch (error) {
        if (options.providerId) await emit({ type: "provider_error", providerId: options.providerId, model: options.model, message: error instanceof Error ? error.message : String(error) });
        throw error;
      }

      if (assistant.stopReason === "error") {
        providerError = assistant.errorMessage ?? getText(assistant);
        if (options.providerId) await emit({ type: "provider_error", providerId: options.providerId, model: options.model, message: providerError });
      }

      if (options.providerId) await emit({ type: "provider_end", providerId: options.providerId, model: options.model, usage: turnUsage });

      finalAssistant = assistant;
      messages.push(assistant);
      await emit({ type: "message_start", message: assistant });
      for (const part of assistant.content) {
        if (!streamedAssistantText && part.type === "text" && part.text) await emit({ type: "assistant_delta", text: part.text });
      }
      await emit({ type: "message_end", message: assistant, durationMs: generationDurationMs, outputTokens: turnUsage?.outputTokens });

      // A provider failure is terminal: retrying or draining follow-ups would
      // just re-hit the same auth/billing/network wall.
      if (providerError) {
        await emit({ type: "turn_end", iteration, message: assistant, toolResults: [] });
        break;
      }

      const toolCalls = assistant.content.filter((part): part is ToolCallPart => part.type === "toolCall");
      if (budgetExceeded && typeof tokenBudget === "number") {
        await emit({ type: "turn_end", iteration, message: assistant, toolResults: [] });
        const status = tokenBudgetStatus(usageSummary, tokenBudget);
        await emit({ type: "token_budget_exceeded", sessionId, limit: status.limit, used: status.used, percent: status.percent, handoffSummary: summarizeMessagesForHandoff(messages) });
        const capped: AssistantMessage = { role: "assistant", content: [{ type: "text", text: `Token budget reached (${status.used.toLocaleString("en-US")}/${status.limit.toLocaleString("en-US")}); pending tool calls were not executed.` }], stopReason: "end", timestamp: Date.now() };
        messages.push(capped);
        finalAssistant = capped;
        await emit({ type: "message_start", message: capped });
        await emit({ type: "message_end", message: capped });
        break;
      }
      if (toolCalls.length === 0 || assistant.stopReason !== "tool_calls") {
        await emit({ type: "turn_end", iteration, message: assistant, toolResults: [] });
        const followUps = await drainFollowUps();
        if (followUps > 0 && iteration < maxIterations) continue;
        break;
      }

      const toolResults = await executeToolCalls(toolCalls, tools, toolContext, emit, approvalMode, extensionHooks, extensionFileTriggers, extensionApprovalPolicies, extensionRuntime, checkpoints, checkpointsEnabled, options.signal, options.approvalSignal, options.uiBridge);

      for (const result of toolResults) {
        messages.push(result);
        await emit({ type: "message_start", message: result });
        await emit({ type: "message_end", message: result });
      }

      await emit({ type: "turn_end", iteration, message: assistant, toolResults });
      await persistTurn(iteration);
      await drainFollowUps();
      if (toolResults.some((result) => result.terminate)) break;

      if (stallDetector) {
        for (const call of toolCalls) {
          const result = toolResults.find((item) => item.toolCallId === call.id);
          const stall = stallDetector.record({ name: call.name, arguments: call.arguments, isError: result?.isError ?? false });
          if (!stall) continue;
          stallError = stall;
          await emit({ type: "agent_stalled", sessionId, reason: stall, toolName: call.name });
          const stopped: AssistantMessage = {
            role: "assistant",
            content: [{ type: "text", text: stall }],
            stopReason: "error",
            timestamp: Date.now(),
            errorMessage: stall
          };
          messages.push(stopped);
          finalAssistant = stopped;
          await emit({ type: "message_start", message: stopped });
          await emit({ type: "message_end", message: stopped });
          break;
        }
        if (stallError) break;
      }

      const manualCompactRequested = Boolean(options.manualCompactSignal?.requested);
      const manualPreviewRequested = Boolean(options.manualCompactSignal?.preview);
      if (manualCompactRequested && options.manualCompactSignal) {
        options.manualCompactSignal.requested = false;
        options.manualCompactSignal.preview = false;
      }
      const thresholdExceeded = autoCompactThreshold !== undefined && currentContextTokens(usageSummary) >= autoCompactThreshold;
      const budgetCompactRequested = budgetDownshiftRequested;
      budgetDownshiftRequested = false;
      if (manualCompactRequested || thresholdExceeded || budgetCompactRequested) {
        const originalMessageCount = messages.length;
        const keepRecentMessages = manualCompactRequested ? 6 : 8;
        await emit({
          type: "session_compaction_progress",
          phase: "requested",
          percent: 5,
          message: manualCompactRequested ? "Manual compaction requested." : budgetCompactRequested ? "Token budget reached 80%; compacting context before continuing." : "Auto-compaction threshold reached.",
          originalMessageCount,
          retainedMessageCount: Math.min(keepRecentMessages, originalMessageCount)
        });
        await emit({
          type: "session_compaction_progress",
          phase: "summarizing",
          percent: 35,
          message: "Summarizing older conversation context…",
          originalMessageCount,
          retainedMessageCount: Math.min(keepRecentMessages, originalMessageCount)
        });
        try {
          let proposal = await prepareLiveCompaction(messages, {
            modelClient,
            signal: options.signal,
            // Manual compaction should engage even on shorter histories.
            ...(manualCompactRequested ? { keepRecentMessages, minMessages: 8 } : {})
          });
          if (!proposal) {
            await emit({
              type: "session_compaction_progress",
              phase: "skipped",
              percent: 100,
              message: "Nothing to compact yet; the conversation is still small.",
              originalMessageCount,
              retainedMessageCount: originalMessageCount
            });
          } else {
            let editedSummary: string | undefined;
            let cancelled = false;
            // Extensions get a turn on the summary before a human previews it, so the preview
            // shows the final proposed text and a manual edit still wins.
            if (proposal.fallbackReason) {
              await emit({
                type: "backend_debug",
                timestamp: new Date().toISOString(),
                level: "warn",
                source: "session-compaction",
                message: "Compaction fell back to the deterministic summary",
                details: { reason: proposal.fallbackReason }
              });
            }
            const hookOutcome = await runCompactionHooks(extensionHooks, {
              summary: proposal.summary,
              source: proposal.source,
              fallbackReason: proposal.fallbackReason,
              originalMessageCount: proposal.originalMessageCount,
              retainedMessageCount: proposal.retainedMessageCount,
              cwd: request.cwd,
              sessionId
            });
            for (const note of hookOutcome.notes) await emit({ type: "backend_debug", timestamp: new Date().toISOString(), level: "info", source: "extension-hooks", message: "compaction context", details: { context: note } });
            if (hookOutcome.summary !== proposal.summary) proposal = { ...proposal, summary: hookOutcome.summary };
            const previewThisCompaction = Boolean(compactionPreviewSignal) && (compactionPreviewEnabled || (manualCompactRequested && manualPreviewRequested));
            if (previewThisCompaction && compactionPreviewSignal) {
              const previewId = `preview_${Date.now()}`;
              await emit({
                type: "session_compaction_preview",
                previewId,
                summary: proposal.summary,
                source: proposal.source,
                originalMessageCount: proposal.originalMessageCount,
                retainedMessageCount: proposal.retainedMessageCount
              });
              const decision = await waitForCompactionPreviewDecision(previewId, compactionPreviewSignal, options.signal);
              cancelled = !decision.approved;
              editedSummary = decision.summary;
            }
            if (cancelled) {
              await emit({
                type: "session_compaction_progress",
                phase: "skipped",
                percent: 100,
                message: "Compaction preview cancelled; context left unchanged.",
                originalMessageCount,
                retainedMessageCount: originalMessageCount
              });
            } else {
              const applied = applyCompactionProposal(proposal, { editedSummary });
              await emit({
                type: "session_compaction_progress",
                phase: "saving",
                percent: 80,
                message: "Installing compacted context…",
                originalMessageCount: applied.compaction.originalMessageCount,
                retainedMessageCount: applied.compaction.retainedMessageCount
              });
              messages = applied.messages;
              compactions.push(applied.compaction);
              for (const providerId of Object.keys(providerSessionIds)) delete providerSessionIds[providerId];
              await modelClient.resetSessionContinuation?.(sessionId);
              // Reset the live-context measurement so compaction does not re-fire
              // before the next turn provides a real input-token count.
              usageSummary = { ...usageSummary, lastInputTokens: 0 };
              await emit({
                type: "session_compacted",
                compactionId: applied.compaction.id,
                originalMessageCount: applied.compaction.originalMessageCount,
                retainedMessageCount: applied.compaction.retainedMessageCount,
                summary: applied.compaction.summary
              });
            }
          }
        } catch (error) {
          await emit({
            type: "session_compaction_progress",
            phase: "failed",
            percent: 100,
            message: `Compaction failed: ${error instanceof Error ? error.message : String(error)}`,
            originalMessageCount,
            retainedMessageCount: originalMessageCount
          });
          throw error;
        }
      }

      // Only reachable when a caller explicitly set a cap; the task is unfinished,
      // so this is a truncation, not a completion.
      if (iteration === maxIterations) {
        iterationCapReached = true;
        const capped: AssistantMessage = {
          role: "assistant",
          content: [{ type: "text", text: `Stopped after maxIterations=${maxIterations}. The task may be unfinished; raise --max-iterations or set maxIterations=0 for unlimited.` }],
          stopReason: "error",
          timestamp: Date.now()
        };
        messages.push(capped);
        finalAssistant = capped;
        await emit({ type: "message_start", message: capped });
        await emit({ type: "message_end", message: capped });
      }
    }
  } catch (error) {
    await emit({ type: "agent_error", sessionId, message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
    // Keep whatever the run completed before it failed. Without this, a provider
    // crash mid-run discards every turn that already succeeded.
    await persistTurn(-1);
    throw error;
  }

  let verification: { ok: boolean; checks: VerificationResult[] } | undefined;
  if (options.verify) {
    const checks = await loadVerificationChecks(request.cwd);
    await emit({ type: "verification_start", checks: checks.map((check) => check.id) });
    const checkResults = await runVerificationChecks(checks, options.signal);
    verification = { ok: checkResults.every((check) => check.ok), checks: checkResults };
    await emit({ type: "verification_end", ok: verification.ok, checks: checkResults });
  }

  await emit({ type: "agent_end", sessionId, messages });

  const extensionEntries = [...priorExtensionEntries, ...extensionRuntime.entries.slice(runEntriesStart)];
  const sessionFile = await persistCurrentSession();
  if (sessionFile) await emit({ type: "session_saved", sessionId, path: sessionFile });

  return {
    sessionId,
    mode,
    providerId: options.providerId,
    model: options.model,
    messages,
    activatedSkills: [...skills.map((skill) => skill.id), ...activatedExtensions],
    activatedExtensions,
    retrievedDocs: docs.map((doc) => doc.id),
    mutationLog,
    externalDirectories,
    usage: usageSummary,
    project,
    compactions,
    checkpoints,
    modelTurns,
    providerSessionIds,
    extensionEntries,
    sessionFile,
    summary: summarizeRun(mode, finalAssistant, mutationLog, providerError ?? stallError ?? (approvalDenied ? "Approval denied." : undefined), iterationCapReached),
    notes: buildNotes(mode, docs),
    budgetExceeded,
    ...(providerError ? { providerError } : {}),
    ...(stallError ? { stallError } : {}),
    ...(iterationCapReached ? { iterationCapReached } : {}),
    ...(approvalDenied ? { approvalDenied } : {}),
    verification
  };
}

async function executeToolCalls(
  toolCalls: ToolCallPart[],
  tools: ToolDefinition[],
  context: ToolContext,
  emit: AgentEventSink,
  approvalMode: ApprovalMode,
  extensionHooks: LoadedExtensionHook[],
  extensionFileTriggers: LoadedExtensionFileTrigger[],
  extensionApprovalPolicies: LoadedExtensionApprovalPolicy[],
  extensionRuntime: LoadedCrewCoderExtensionRuntime,
  checkpoints: SessionCheckpoint[],
  checkpointsEnabled: boolean,
  signal?: AbortSignal,
  approvalSignal?: { decisions: ApprovalControlDecision[] },
  uiBridge?: ExtensionUiBridge
): Promise<ToolResultMessage[]> {
  const results: ToolResultMessage[] = [];
  let index = 0;

  while (index < toolCalls.length) {
    const call = toolCalls[index];
    if (!call) break;
    const parallel = findTool(call.name, tools)?.executionMode === "parallel";
    const batchEnd = parallel
      ? toolCalls.findIndex((candidate, candidateIndex) => candidateIndex > index && findTool(candidate.name, tools)?.executionMode !== "parallel")
      : index + 1;
    const end = batchEnd < 0 ? toolCalls.length : batchEnd;
    const batch = toolCalls.slice(index, end);
    const batchResults = parallel
      ? (await Promise.all(batch.map((candidate) => executeToolCallsSequential([candidate], tools, context, emit, approvalMode, extensionHooks, extensionFileTriggers, extensionApprovalPolicies, extensionRuntime, checkpoints, checkpointsEnabled, signal, approvalSignal, uiBridge)))).flat()
      : await executeToolCallsSequential(batch, tools, context, emit, approvalMode, extensionHooks, extensionFileTriggers, extensionApprovalPolicies, extensionRuntime, checkpoints, checkpointsEnabled, signal, approvalSignal, uiBridge);
    results.push(...batchResults);
    if (batchResults.some((result) => result.terminate)) break;
    index = end;
  }

  return results;
}

async function executeToolCallsSequential(
  toolCalls: ToolCallPart[],
  tools: ToolDefinition[],
  context: ToolContext,
  emit: AgentEventSink,
  approvalMode: ApprovalMode,
  extensionHooks: LoadedExtensionHook[],
  extensionFileTriggers: LoadedExtensionFileTrigger[],
  extensionApprovalPolicies: LoadedExtensionApprovalPolicy[],
  extensionRuntime: LoadedCrewCoderExtensionRuntime,
  checkpoints: SessionCheckpoint[],
  checkpointsEnabled: boolean,
  signal?: AbortSignal,
  approvalSignal?: { decisions: ApprovalControlDecision[] },
  uiBridge?: ExtensionUiBridge
): Promise<ToolResultMessage[]> {
  const results: ToolResultMessage[] = [];

  for (const originalToolCall of toolCalls) {
    let toolCall = originalToolCall;
    const hookDecision = await runBeforeToolHooks(extensionHooks, toolCall, context);
    if (hookDecision.context) await emit({ type: "backend_debug", timestamp: new Date().toISOString(), level: "info", source: "extension-hooks", message: "beforeToolCall context", details: { toolName: toolCall.name, context: hookDecision.context } });
    if (hookDecision.action === "block") {
      const blocked: ToolResultMessage = {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: `Blocked by extension hook: ${hookDecision.reason}` }],
        isError: true,
        terminate: true,
        timestamp: Date.now()
      };
      await emit({ type: "tool_execution_end", toolCallId: toolCall.id, toolName: toolCall.name, result: blocked, isError: true });
      results.push(blocked);
      break;
    }
    if (hookDecision.action === "modify") toolCall = { ...toolCall, arguments: hookDecision.args };

    const apiBeforeResults = await emitCrewCoderExtensionEvent(extensionRuntime, "before_tool_call", { toolCall, context }, { cwd: context.cwd, sessionId: context.sessionId, signal }, uiBridge);
    const apiDecision = normalizeBeforeToolEventResults(apiBeforeResults);
    if (apiDecision.context) await emit({ type: "backend_debug", timestamp: new Date().toISOString(), level: "info", source: "crewcode-ext-api", message: "before_tool_call context", details: { toolName: toolCall.name, context: apiDecision.context } });
    if (apiDecision.action === "block") {
      const blocked: ToolResultMessage = {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: `Blocked by CrewCoderExtAPI handler: ${apiDecision.reason ?? "blocked"}` }],
        isError: true,
        terminate: true,
        timestamp: Date.now()
      };
      await emit({ type: "tool_execution_end", toolCallId: toolCall.id, toolName: toolCall.name, result: blocked, isError: true });
      results.push(blocked);
      break;
    }
    if (apiDecision.action === "modify" && apiDecision.args) toolCall = { ...toolCall, arguments: apiDecision.args };

    const policyDecision = evaluateExtensionApprovalPolicies(extensionApprovalPolicies, toolCall);
    if (policyDecision.action === "block") {
      const blocked: ToolResultMessage = {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: `Blocked by extension approval policy: ${policyDecision.reason}` }],
        isError: true,
        terminate: true,
        timestamp: Date.now()
      };
      await emit({ type: "tool_execution_end", toolCallId: toolCall.id, toolName: toolCall.name, result: blocked, isError: true });
      results.push(blocked);
      break;
    }

    const tool = findTool(toolCall.name, tools);
    const baseApproval = decideApproval({ approvalMode, tool, args: toolCall.arguments });
    const approval = policyDecision.action === "review" && !baseApproval.required
      ? { ...baseApproval, required: true, approved: false, risk: policyDecision.risk, reason: policyDecision.reason }
      : policyDecision.action === "review"
        ? { ...baseApproval, risk: policyDecision.risk, reason: `${baseApproval.reason}\n${policyDecision.reason}` }
        : baseApproval;
    const approvalId = `approval_${toolCall.id}`;
    let approvedToRun = approval.approved;

    if (approval.required) {
      await emit({
        type: "approval_required",
        approvalId,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        risk: approval.risk,
        reason: approval.reason,
        args: toolCall.arguments
      });

      const decision = approvalSignal
        ? await waitForApprovalDecision(approvalId, approvalSignal, signal)
        : { approved: false, reason: "Non-interactive approval gate paused execution." };
      await emit({ type: "approval_resolved", approvalId, approved: decision.approved, reason: decision.reason });

      if (!decision.approved) {
        const denied: ToolResultMessage = {
          role: "toolResult",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: [{ type: "text", text: `Approval denied before running ${toolCall.name}: ${decision.reason ?? approval.reason}` }],
          isError: true,
          terminate: true,
          timestamp: Date.now()
        };
        await emit({ type: "tool_execution_end", toolCallId: toolCall.id, toolName: toolCall.name, result: denied, isError: true });
        results.push(denied);
        break;
      }

      approvedToRun = true;
    }

    if (!approvedToRun && approval.risk === "dangerous") {
      const blocked: ToolResultMessage = {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: `Blocked dangerous tool call: ${approval.reason}` }],
        isError: true,
        terminate: true,
        timestamp: Date.now()
      };
      await emit({ type: "tool_execution_end", toolCallId: toolCall.id, toolName: toolCall.name, result: blocked, isError: true });
      results.push(blocked);
      break;
    }

    const startMetadata = toolEventMetadata(toolCall.name);
    await emit({ type: "tool_execution_start", toolCallId: toolCall.id, toolName: toolCall.name, args: toolCall.arguments, metadata: startMetadata });

    const isValidation = toolCall.name === "validatePlugin";
    if (isValidation) {
      await emit({ type: "validation_start", target: String(toolCall.arguments.path ?? ".") });
    }

    const beforeMutationCount = context.mutationLog.length;
    let result: ToolResultMessage;
    let executedDetails: Record<string, unknown> | undefined;
    try {
      if (!tool) throw new Error(`Tool not found: ${toolCall.name}`);
      if (signal?.aborted) throw new Error("Operation aborted");
      const parsedArgs = tool.parse(toolCall.arguments);
      if (tool.isMutation && checkpointsEnabled) {
        const checkpoint = await createSessionCheckpoint({ sessionId: context.sessionId, cwd: context.cwd, reason: `Before ${toolCall.name}`, toolCallId: toolCall.id, toolName: toolCall.name });
        checkpoints.push(checkpoint);
        checkpoints.splice(0, Math.max(0, checkpoints.length - MAX_SESSION_CHECKPOINTS));
        await emit({ type: "checkpoint_created", checkpointId: checkpoint.id, sessionId: context.sessionId, reason: checkpoint.reason, toolCallId: checkpoint.toolCallId, toolName: checkpoint.toolName, fileCount: checkpoint.fileCount, totalBytes: checkpoint.totalBytes, truncated: checkpoint.truncated });
      }
      const executed = await tool.execute(parsedArgs, context, signal);
      executedDetails = executed.details;
      result = {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: executed.content,
        isError: false,
        terminate: executed.terminate,
        timestamp: Date.now(),
        details: executedDetails
      };
      for (const part of executed.content) await emit({ type: "tool_delta", toolCallId: toolCall.id, toolName: toolCall.name, text: part.text, metadata: mergeToolMetadata(startMetadata, executedDetails) });
    } catch (error) {
      result = {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        isError: true,
        timestamp: Date.now()
      };
    }

    for (const changed of context.mutationLog.slice(beforeMutationCount)) {
      await emit({ type: "file_changed", path: changed, toolName: toolCall.name });
      const triggerResults = await runExtensionFileTriggers(extensionFileTriggers, { path: changed, toolName: toolCall.name, cwd: context.cwd, sessionId: context.sessionId });
      for (const triggerResult of triggerResults.filter((item) => item.matched && item.output?.trim())) {
        await emit({
          type: "backend_debug",
          timestamp: new Date().toISOString(),
          level: "info",
          source: "extension-file-trigger",
          message: "file trigger output",
          details: { extensionId: triggerResult.trigger.extensionId, triggerId: triggerResult.trigger.triggerId, path: changed, output: triggerResult.output }
        });
      }
    }

    if (result.isError) {
      const errorHookNotes = await runErrorHooks(extensionHooks, toolCall, result, context);
      for (const note of errorHookNotes) await emit({ type: "backend_debug", timestamp: new Date().toISOString(), level: "warn", source: "extension-hooks", message: "onError context", details: { toolName: toolCall.name, context: note } });
    }

    const afterHookNotes = await runAfterToolHooks(extensionHooks, toolCall, result, context);
    for (const note of afterHookNotes) await emit({ type: "backend_debug", timestamp: new Date().toISOString(), level: "info", source: "extension-hooks", message: "afterToolCall context", details: { toolName: toolCall.name, context: note } });
    const apiAfterResults = await emitCrewCoderExtensionEvent(extensionRuntime, "after_tool_call", { toolCall, result, context }, { cwd: context.cwd, sessionId: context.sessionId, signal }, uiBridge);
    for (const note of collectContextEventResults(apiAfterResults)) await emit({ type: "backend_debug", timestamp: new Date().toISOString(), level: "info", source: "crewcode-ext-api", message: "after_tool_call context", details: { toolName: toolCall.name, context: note } });

    if (isValidation) {
      const details = executedDetails as { ok?: boolean; errors?: string[]; warnings?: string[] } | undefined;
      const ok = !result.isError && (details?.ok ?? true);
      await emit({
        type: "validation_end",
        target: String(toolCall.arguments.path ?? "."),
        ok,
        errors: details?.errors ?? (result.isError ? [result.content.map((c) => c.text).join("\n")] : []),
        warnings: details?.warnings ?? []
      });
    }

    await emit({ type: "tool_execution_end", toolCallId: toolCall.id, toolName: toolCall.name, result, isError: result.isError, metadata: mergeToolMetadata(startMetadata, result.details) });
    results.push(result);
  }

  return results;
}

async function appendAuditEvent(
  event: AgentEvent,
  context: { cwd: string; sessionId: string; approvals: Map<string, { toolCallId: string; toolName: string; args: Record<string, unknown>; risk: string }> }
): Promise<void> {
  if (event.type === "tool_execution_start") {
    await appendAuditLog({ type: "tool_call", sessionId: context.sessionId, cwd: context.cwd, toolCallId: event.toolCallId, toolName: event.toolName, args: event.args, details: event.metadata });
    return;
  }
  if (event.type === "tool_execution_end") {
    await appendAuditLog({ type: "tool_result", sessionId: context.sessionId, cwd: context.cwd, toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError, details: event.metadata });
    return;
  }
  if (event.type === "approval_required") {
    context.approvals.set(event.approvalId, { toolCallId: event.toolCallId, toolName: event.toolName, args: event.args, risk: event.risk });
    await appendAuditLog({ type: "approval", sessionId: context.sessionId, cwd: context.cwd, toolCallId: event.toolCallId, toolName: event.toolName, risk: event.risk, reason: event.reason, args: event.args, approved: false });
    return;
  }
  if (event.type === "approval_resolved") {
    const approval = context.approvals.get(event.approvalId);
    if (approval) context.approvals.delete(event.approvalId);
    await appendAuditLog({ type: "approval", sessionId: context.sessionId, cwd: context.cwd, toolCallId: approval?.toolCallId, toolName: approval?.toolName, risk: approval?.risk, reason: event.reason, args: approval?.args, approved: event.approved });
    return;
  }
  if (event.type === "file_changed") {
    await appendAuditLog({ type: "write", sessionId: context.sessionId, cwd: context.cwd, toolName: event.toolName, path: event.path });
  }
}

function toolEventMetadata(toolName: string): Record<string, unknown> | undefined {
  if (!toolName.startsWith("extension_")) return undefined;
  return { source: "extension" };
}

function mergeToolMetadata(...items: Array<Record<string, unknown> | undefined>): Record<string, unknown> | undefined {
  const merged = Object.assign({}, ...items.filter(Boolean));
  return Object.keys(merged).length ? merged : undefined;
}

async function waitForApprovalDecision(
  approvalId: string,
  approvalSignal: { decisions: ApprovalControlDecision[] },
  signal?: AbortSignal
): Promise<ApprovalControlDecision> {
  while (!signal?.aborted) {
    const index = approvalSignal.decisions.findIndex((decision) => decision.approvalId === approvalId);
    if (index >= 0) {
      const [decision] = approvalSignal.decisions.splice(index, 1);
      if (decision) return decision;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { approvalId, approved: false, reason: "Approval wait aborted." };
}

async function waitForCompactionPreviewDecision(
  previewId: string,
  signalQueue: { decisions: CompactionPreviewDecision[] },
  signal?: AbortSignal
): Promise<CompactionPreviewDecision> {
  while (!signal?.aborted) {
    const index = signalQueue.decisions.findIndex((decision) => decision.previewId === previewId);
    if (index >= 0) {
      const [decision] = signalQueue.decisions.splice(index, 1);
      if (decision) return decision;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { previewId, approved: false };
}

function selectSkills(mode: ResolvedAgentMode, prompt: string): Skill[] {
  // General-mode skills are NOT auto-injected into the system prompt. They are
  // user-authored, on-demand skills surfaced only via the `/skills` command
  // (see src/skills/filesystem/loader.ts). Auto-injection is reserved for the
  // CrewCode plugin skill pack in plugin mode.
  if (mode === "extension") {
    const matched = crewcoderExtensionSkills.filter((skill) => skill.matches(prompt));
    if (matched.length > 0) return matched;
    return crewcoderExtensionSkills.filter((skill) => ["crewcoder.extension.manifest", "crewcoder.extension.trust"].includes(skill.id));
  }
  if (mode !== "plugin") return [];
  const matched = crewcodeSkills.filter((skill) => skill.matches(prompt));
  if (matched.length > 0) return matched;
  return crewcodeSkills.filter((skill) => ["crewcode.plugin.manifest", "crewcode.plugin.security"].includes(skill.id));
}

/**
 * The full doc catalog for the mode — deliberately NOT filtered by the prompt.
 *
 * Keyword matching used to select these, which was worse on both axes: a miss fell
 * back to dumping most of the set (so the least relevant prompts cost the most
 * tokens), and a near-miss hid the exact doc the model needed. The prompt renders
 * only ids from this list (~70 tokens), and the model pulls bodies through the
 * `docs` tool when it actually needs them.
 */
function selectDocs(mode: ResolvedAgentMode): EmbeddedDoc[] {
  if (mode === "general") return [];
  return mode === "extension" ? embeddedCrewCoderExtensionDocs : embeddedCrewCodeDocs;
}

function summarizeRun(mode: ResolvedAgentMode, assistant: AssistantMessage | undefined, mutationLog: string[], failure?: string, truncated = false): string {
  const text = assistant ? getText(assistant) : "No assistant response was produced.";
  const changed = mutationLog.length ? `\n\nChanged files:\n${[...new Set(mutationLog)].map((file) => `- ${file}`).join("\n")}` : "";
  const headline = failure
    ? `CrewCoder failed in ${mode} mode.`
    : truncated
      ? `CrewCoder stopped early in ${mode} mode.`
      : `CrewCoder completed in ${mode} mode.`;
  return [headline, "", text, changed].join("\n").trim();
}

function buildNotes(mode: ResolvedAgentMode, docs: EmbeddedDoc[]): string[] {
  if (mode === "general") return ["General mode is active. CrewCode plugin and CrewCoder extension constraints are not enforced; select an explicit mode for those."];
  // The catalog is offered, not injected: only ids reach the prompt, and the model
  // pulls bodies through the `docs` tool. Report the count, not 14 titles of noise.
  const available = `${docs.length} embedded docs available; the agent fetches bodies on demand with the docs tool.`;
  if (mode === "extension") return ["Extension mode is active. CrewCoder extension manifest and trust-tier constraints are enforced in prompts.", available];
  return ["Plugin mode is active. CrewCode v0 sandbox and permission constraints are enforced in prompts and validation.", available];
}
