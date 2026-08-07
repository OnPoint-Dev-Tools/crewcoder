import { runAgentLoop, type AgentLoopResult } from "./core/agent-loop.js";
import { runAgentLoopContinue } from "./core/agent-loop-continue.js";
import type { ApprovalMode } from "./core/approval.js";
import type { AgentEventSink } from "./core/events.js";
import { createExtensionUiBridge, type ExtensionUiResponseValue } from "./core/extension-ui-bridge.js";
import { readConfig } from "./core/config.js";
import { loadSession } from "./core/session-loader.js";
import { HeuristicModelClient, type ModelClient } from "./core/model-client.js";
import type { ApprovalControlDecision } from "./core/stdin-control.js";
import type { TextFileHost, ToolDefinition } from "./core/tool-types.js";
import type { AgentMode } from "./core/types.js";
import { ProviderModelClient } from "./providers/provider-model-client.js";
import { resolveModel } from "./providers/model-registry.js";

export type CrewCoderRuntimeUiResponder = (requestId: string, value: ExtensionUiResponseValue) => boolean;

export type CrewCoderRuntimeOptions = {
  cwd?: string;
  externalDirectories?: string[];
  mode?: AgentMode;
  provider?: string;
  model?: string;
  effort?: string;
  approval?: ApprovalMode;
  maxIterations?: number;
  tokenBudget?: number;
  verify?: boolean;
  systemPrompt?: string;
  worker?: string;
  persistSession?: boolean;
  sessionId?: string;
  customTools?: ToolDefinition[];
  textFiles?: TextFileHost;
  modelClient?: ModelClient;
  heuristic?: boolean;
  emit?: AgentEventSink;
  signal?: AbortSignal;
  followUpSignal?: { messages: string[] };
  approvalSignal?: { decisions: ApprovalControlDecision[] };
  setUiResponder?(responder: CrewCoderRuntimeUiResponder | undefined): void;
  state?: AgentLoopResult;
};

export async function runCrewCoderRuntimeTurn(
  prompt: string,
  options: CrewCoderRuntimeOptions = {},
  images: string[] = []
): Promise<AgentLoopResult> {
  const config = readConfig();
  const persistedState = !options.state && options.sessionId ? await loadSession(options.sessionId) : undefined;
  const cwd = options.cwd ?? options.state?.project.cwd ?? persistedState?.cwd ?? process.cwd();
  const externalDirectories = options.externalDirectories ?? options.state?.externalDirectories ?? persistedState?.externalDirectories ?? [];
  const providerId = options.provider
    ?? process.env.CREWCODER_PROVIDER
    ?? options.state?.providerId
    ?? persistedState?.provider
    ?? config.defaultProvider;
  const requestedModel = options.model
    ?? process.env.CREWCODER_MODEL
    ?? options.state?.model
    ?? persistedState?.model
    ?? config.defaultModel;
  const resolvedModel = options.modelClient || options.heuristic
    ? undefined
    : await resolveModel(providerId, requestedModel);
  const model = resolvedModel?.model ?? requestedModel;
  const uiBridge = createExtensionUiBridge({
    emit: options.emit,
    hasUI: Boolean(options.setUiResponder),
    signal: options.signal
  });
  options.setUiResponder?.((requestId, value) => uiBridge.resolveResponse(requestId, value));

  const modelClient = options.modelClient
    ?? (options.heuristic ? new HeuristicModelClient() : new ProviderModelClient(providerId, cwd, model, undefined, config.thinkingEnabled ? options.effort : "none"));
  const common = {
    providerId,
    model,
    contextWindow: resolvedModel?.metadata?.contextWindow,
    approvalMode: options.approval ?? "never" as ApprovalMode,
    maxIterations: options.maxIterations,
    tokenBudget: options.tokenBudget,
    verify: options.verify,
    systemPromptName: options.systemPrompt,
    workerName: options.worker,
    persistSession: options.persistSession,
    additionalTools: options.customTools,
    textFiles: options.textFiles,
    modelClient,
    signal: options.signal,
    followUpSignal: options.followUpSignal,
    approvalSignal: options.approvalSignal,
    uiBridge,
    emit: options.emit
  };

  try {
    if (options.state) {
      const state = options.state;
      return await runAgentLoop({
        prompt,
        requestedMode: options.mode ?? state.mode,
        cwd,
        externalDirectories,
        images
      }, {
        ...common,
        sessionId: state.sessionId,
        resumeFromSessionId: state.sessionId,
        initialMessages: state.messages,
        initialMutationLog: state.mutationLog,
        initialUsage: state.usage,
        initialCompactions: state.compactions,
        initialCheckpoints: state.checkpoints,
        initialModelTurns: state.modelTurns,
        initialProviderSessionIds: state.providerSessionIds,
        initialExtensionEntries: state.extensionEntries ?? []
      });
    }

    if (options.sessionId) {
      return await runAgentLoopContinue({
        sessionId: options.sessionId,
        prompt,
        mode: options.mode,
        cwd,
        externalDirectories,
        images
      }, common);
    }

    return await runAgentLoop({
      prompt,
      requestedMode: options.mode ?? config.defaultMode,
      cwd,
      externalDirectories,
      images
    }, common);
  } finally {
    uiBridge.cancelAll();
    options.setUiResponder?.(undefined);
  }
}
