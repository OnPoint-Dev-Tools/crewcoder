export {
  createCrewCoderProcess,
  CrewCoderProcess,
  type CrewCoderProcessEventListener,
  type CrewCoderProcessOptions,
  type CrewCoderProcessPromptOptions
} from "./process-client.js";
export {
  CrewCoderError,
  CrewCoderFleetProtocolError,
  CrewCoderFleetRequestError,
  type CrewCoderErrorCode
} from "./errors.js";
export {
  createCrewCoderOrchestrator,
  CrewCoderOrchestrator,
  type CrewCoderCrewInput,
  type CrewCoderHandoffInput,
  type CrewCoderOrchestratorEventListener,
  type CrewCoderOrchestratorOptions,
  type CrewCoderTeamInput
} from "./orchestrator.js";
export type { WorkerCrewRunResult, WorkerHandoffResult, WorkerTeam, WorkerTeamRole, WorkerTeamsManifest } from "@crewcode/crewcoder-agent";
export {
  CrewCoderAdmin,
  CrewCoderConfigAdmin,
  CrewCoderExtensionAdmin,
  CrewCoderGoalAdmin,
  CrewCoderMemoryAdmin,
  CrewCoderProfileAdmin,
  CrewCoderSessionAdmin,
  type CrewCoderAdminOptions,
  type CrewCoderGoalStartOptions,
  type CrewCoderMemoryStatus,
  type CrewCoderProfileScope,
  type CrewCoderRewindOptions,
  type CrewCoderProfileState
} from "./admin.js";
export type {
  CrewCoderConfig,
  CrewCoderConfigSetKey,
  GoalCheckResult,
  GoalPendingApproval,
  GoalProgress,
  GoalRecord,
  GoalStatus,
  ExtensionInstallResult,
  InstallExtensionOptions,
  LoadedCrewCoderExtension,
  RegistrySearchOptions,
  RegistrySearchResult,
  TrustTier,
  UninstallResult,
  IntegrationProfile,
  MemoryEntry,
  SessionCheckpoint,
  SessionCheckpointDiff,
  SessionCheckpointPreview,
  SessionCheckpointRestore,
  SessionListOptions,
  SessionRecord,
  SessionRewindResult,
  SessionSummary
} from "@crewcode/crewcoder-agent";
export {
  CREWCODER_MINIMUM_NODE_VERSION,
  CREWCODER_SDK_API_VERSION,
  CREWCODER_SDK_VERSION
} from "./version.js";
export {
  CREWCODER_FLEET_PROTOCOL_VERSION,
  CrewCoderFleetClient,
  type CrewCoderFleetClientOptions,
  type CrewCoderFleetControl,
  type CrewCoderFleetEvent,
  type CrewCoderFleetEventStreamOptions,
  type CrewCoderFleetHealth,
  type CrewCoderFleetReconnectOptions,
  type CrewCoderFleetProtocolEvent,
  type CrewCoderFleetRunCreated,
  type CrewCoderFleetRunRequest,
  type CrewCoderFleetRunStatus,
  type CrewCoderFleetRunSummary,
  type CrewCoderFleetWaitOptions
} from "./fleet-client.js";

import {
  runCrewCoderRuntimeTurn,
  type AgentEvent,
  type AgentLoopResult,
  type AgentMessage,
  type AgentMode,
  type ApprovalMode,
  type CrewCoderRuntimeUiResponder,
  type ModelClient,
  type TextFileHost,
  type ToolDefinition
} from "@crewcode/crewcoder-agent";
import { CrewCoderError } from "./errors.js";

export type CrewCoderEventListener = (event: AgentEvent) => Promise<void> | void;
export type CrewCoderRunResult = AgentLoopResult;
export type CrewCoderTool<TArgs extends Record<string, unknown> = Record<string, unknown>> = ToolDefinition<TArgs>;

export type CrewCoderSessionOptions = {
  cwd?: string;
  /** Existing directories explicitly granted to this session in addition to cwd. */
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
  /** Existing durable session to resume on the first prompt. */
  sessionId?: string;
  /** Write session history to CrewCoder's durable store. Defaults to true. */
  persistSession?: boolean;
  customTools?: ToolDefinition[];
  textFiles?: TextFileHost;
  /** Custom model implementation for tests, custom providers, or full host control. */
  modelClient?: ModelClient;
  /** Use CrewCoder's deterministic built-in model instead of a configured provider. */
  heuristic?: boolean;
};

export type CrewCoderPromptOptions = {
  images?: string[];
  signal?: AbortSignal;
};

export class CrewCoderSession {
  private readonly options: CrewCoderSessionOptions;
  private readonly listeners = new Set<CrewCoderEventListener>();
  private readonly followUpSignal: { messages: string[] } = { messages: [] };
  private readonly approvalSignal: { decisions: Array<{ approvalId: string; approved: boolean; reason?: string }> } = { decisions: [] };
  private abortController: AbortController | undefined;
  private uiResponder: CrewCoderRuntimeUiResponder | undefined;
  private currentResult: CrewCoderRunResult | undefined;
  private running = false;
  private disposed = false;

  constructor(options: CrewCoderSessionOptions = {}) {
    this.options = { ...options };
  }

  get isRunning(): boolean {
    return this.running;
  }

  get sessionId(): string | undefined {
    return this.currentResult?.sessionId ?? this.options.sessionId;
  }

  get messages(): AgentMessage[] {
    return this.currentResult?.messages ?? [];
  }

  get result(): CrewCoderRunResult | undefined {
    return this.currentResult;
  }

  subscribe(listener: CrewCoderEventListener): () => void {
    this.assertUsable();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async prompt(prompt: string, options: CrewCoderPromptOptions = {}): Promise<CrewCoderRunResult> {
    this.assertUsable();
    if (this.running) throw new CrewCoderError("SESSION_RUNNING", "CrewCoderSession is already running. Use followUp() to queue another instruction.");
    if (!prompt.trim()) throw new CrewCoderError("INVALID_ARGUMENT", "CrewCoderSession.prompt() requires a non-empty prompt.");

    this.running = true;
    this.abortController = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([this.abortController.signal, options.signal])
      : this.abortController.signal;

    try {
      const result = await runCrewCoderRuntimeTurn(prompt.trim(), {
        ...this.options,
        sessionId: this.currentResult ? undefined : this.options.sessionId,
        state: this.currentResult,
        signal,
        followUpSignal: this.followUpSignal,
        approvalSignal: this.approvalSignal,
        emit: async (event) => {
          for (const listener of [...this.listeners]) await listener(event);
        },
        setUiResponder: (responder) => {
          this.uiResponder = responder;
        }
      }, options.images);
      this.currentResult = result;
      return result;
    } finally {
      this.running = false;
      this.abortController = undefined;
      this.uiResponder = undefined;
    }
  }

  followUp(message: string): boolean {
    if (!this.running || !message.trim()) return false;
    this.followUpSignal.messages.push(message.trim());
    return true;
  }

  approve(approvalId: string, approved: boolean, reason?: string): boolean {
    if (!this.running || !approvalId.trim()) return false;
    this.approvalSignal.decisions.push({
      approvalId: approvalId.trim(),
      approved,
      ...(reason?.trim() ? { reason: reason.trim() } : {})
    });
    return true;
  }

  respondToUi(requestId: string, value: string | boolean | null): boolean {
    if (!this.running || !requestId.trim() || !this.uiResponder) return false;
    return this.uiResponder(requestId.trim(), value);
  }

  abort(): boolean {
    if (!this.abortController) return false;
    this.abortController.abort();
    return true;
  }

  dispose(): void {
    this.abort();
    this.listeners.clear();
    this.followUpSignal.messages.length = 0;
    this.approvalSignal.decisions.length = 0;
    this.uiResponder = undefined;
    this.disposed = true;
  }

  private assertUsable(): void {
    if (this.disposed) throw new CrewCoderError("SESSION_DISPOSED", "CrewCoderSession has been disposed.");
  }
}

export function createCrewCoderSession(options: CrewCoderSessionOptions = {}): CrewCoderSession {
  return new CrewCoderSession(options);
}

export type {
  AgentEvent,
  AgentMessage,
  AgentMode,
  ApprovalMode,
  ModelClient,
  TextFileHost,
  ToolDefinition
} from "@crewcode/crewcoder-agent";
