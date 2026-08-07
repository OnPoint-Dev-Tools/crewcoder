export { createCrewCoderProcess, CrewCoderProcess, type CrewCoderProcessEventListener, type CrewCoderProcessOptions, type CrewCoderProcessPromptOptions } from "./process-client.js";
export { CrewCoderError, CrewCoderFleetProtocolError, CrewCoderFleetRequestError, type CrewCoderErrorCode } from "./errors.js";
export { createCrewCoderOrchestrator, CrewCoderOrchestrator, type CrewCoderCrewInput, type CrewCoderHandoffInput, type CrewCoderOrchestratorEventListener, type CrewCoderOrchestratorOptions, type CrewCoderTeamInput } from "./orchestrator.js";
export type { WorkerCrewRunResult, WorkerHandoffResult, WorkerTeam, WorkerTeamRole, WorkerTeamsManifest } from "@crewcode/crewcoder-agent";
export { CrewCoderAdmin, CrewCoderConfigAdmin, CrewCoderExtensionAdmin, CrewCoderGoalAdmin, CrewCoderMemoryAdmin, CrewCoderProfileAdmin, CrewCoderSessionAdmin, type CrewCoderAdminOptions, type CrewCoderGoalStartOptions, type CrewCoderMemoryStatus, type CrewCoderProfileScope, type CrewCoderRewindOptions, type CrewCoderProfileState } from "./admin.js";
export type { CrewCoderConfig, CrewCoderConfigSetKey, GoalCheckResult, GoalPendingApproval, GoalProgress, GoalRecord, GoalStatus, ExtensionInstallResult, InstallExtensionOptions, LoadedCrewCoderExtension, RegistrySearchOptions, RegistrySearchResult, TrustTier, UninstallResult, IntegrationProfile, MemoryEntry, SessionCheckpoint, SessionCheckpointDiff, SessionCheckpointPreview, SessionCheckpointRestore, SessionListOptions, SessionRecord, SessionRewindResult, SessionSummary } from "@crewcode/crewcoder-agent";
export { CREWCODER_MINIMUM_NODE_VERSION, CREWCODER_SDK_API_VERSION, CREWCODER_SDK_VERSION } from "./version.js";
export { CREWCODER_FLEET_PROTOCOL_VERSION, CrewCoderFleetClient, type CrewCoderFleetClientOptions, type CrewCoderFleetControl, type CrewCoderFleetEvent, type CrewCoderFleetEventStreamOptions, type CrewCoderFleetHealth, type CrewCoderFleetReconnectOptions, type CrewCoderFleetProtocolEvent, type CrewCoderFleetRunCreated, type CrewCoderFleetRunRequest, type CrewCoderFleetRunStatus, type CrewCoderFleetRunSummary, type CrewCoderFleetWaitOptions } from "./fleet-client.js";
import { type AgentEvent, type AgentLoopResult, type AgentMessage, type AgentMode, type ApprovalMode, type ModelClient, type TextFileHost, type ToolDefinition } from "@crewcode/crewcoder-agent";
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
export declare class CrewCoderSession {
    private readonly options;
    private readonly listeners;
    private readonly followUpSignal;
    private readonly approvalSignal;
    private abortController;
    private uiResponder;
    private currentResult;
    private running;
    private disposed;
    constructor(options?: CrewCoderSessionOptions);
    get isRunning(): boolean;
    get sessionId(): string | undefined;
    get messages(): AgentMessage[];
    get result(): CrewCoderRunResult | undefined;
    subscribe(listener: CrewCoderEventListener): () => void;
    prompt(prompt: string, options?: CrewCoderPromptOptions): Promise<CrewCoderRunResult>;
    followUp(message: string): boolean;
    approve(approvalId: string, approved: boolean, reason?: string): boolean;
    respondToUi(requestId: string, value: string | boolean | null): boolean;
    abort(): boolean;
    dispose(): void;
    private assertUsable;
}
export declare function createCrewCoderSession(options?: CrewCoderSessionOptions): CrewCoderSession;
export type { AgentEvent, AgentMessage, AgentMode, ApprovalMode, ModelClient, TextFileHost, ToolDefinition } from "@crewcode/crewcoder-agent";
//# sourceMappingURL=index.d.ts.map