export { CREWCODER_VERSION } from "./core/version.js";
export type { CrewCoderExtAPI, CrewCoderExtContext, CrewCoderExtCommandContext, CrewCoderExtEventHandler, CrewCoderExtEventMap, CrewCoderExtEventName, CrewCoderExtToolDefinition, CrewCoderExtCommandDefinition } from "./extensions/api.js";
export type { ToolResult, ToolExecutionMode, JsonObjectSchema, JsonSchema, TextFileHost, ToolContext, ToolDefinition } from "./core/tool-types.js";
export type { AgentMessage, AssistantMessage, ImagePart, MessageContent, TextPart, ToolCallPart, ToolResultMessage, UserMessage } from "./core/messages.js";
export type { AgentEvent, AgentEventSink, ApprovalRisk } from "./core/events.js";
export type { ApprovalMode } from "./core/approval.js";
export type { ModelClient, ModelInput, ModelStreamCallbacks } from "./core/model-client.js";
export type { ModelUsage, TokenUsage, UsageSummary } from "./core/usage.js";
export type { AgentMode, ResolvedAgentMode } from "./core/types.js";
export type { ProviderAuthScheme, ProviderCapabilities, ProviderContinuationMode, ProviderDefinition, ProviderKind, ProviderModel, ProviderReplayPolicy, ProviderRuntime, ProviderTransportChannel, ProviderTransportProfile } from "./providers/types.js";
export type { AgentLoopResult } from "./core/agent-loop.js";
export { runCrewCoderRuntimeTurn } from "./sdk-runtime.js";
export type { CrewCoderRuntimeOptions, CrewCoderRuntimeUiResponder } from "./sdk-runtime.js";
export { getCrewCoderWorkerTeam, handoffCrewCoderSession, listCrewCoderWorkerTeams, runCrewCoderCrew, runCrewCoderTeam } from "./worker-runtime.js";
export type { CrewCoderCrewRuntimeInput, CrewCoderHandoffRuntimeInput, CrewCoderTeamRuntimeInput, CrewCoderWorkerRuntimeOptions } from "./worker-runtime.js";
export type { WorkerCrewRunResult, WorkerHandoffResult } from "./core/worker-crews.js";
export type { WorkerTeam, WorkerTeamRole, WorkerTeamsManifest } from "./core/worker-teams.js";
export { createWorker, deleteWorker, listWorkers, readWorker, setActiveWorker } from "./core/identity.js";
export type { CrewCoderIdentity, CrewCoderWorker } from "./core/identity.js";
export { readConfig, setConfigValue } from "./core/config.js";
export type { CrewCoderConfig, CrewCoderConfigSetKey, GoalConfig, ModelPriceEntry } from "./core/config.js";
export {
  detectCrewCodeProject,
  readProjectIntegrationProfile,
  resolveIntegrationProfile,
  setCrewCodeProfilePromptDismissed,
  setProjectIntegrationProfile
} from "./core/integration-profile.js";
export type { CrewCodeProjectDetection, IntegrationProfile } from "./core/integration-profile.js";
export { createSessionBranch, deleteSessionRecord, getSessionRecord, listSessionSummaries } from "./core/session-admin.js";
export type { SessionListOptions, SessionSummary } from "./core/session-admin.js";
export type { SessionRecord } from "./core/session-store.js";
export { createSessionCheckpoint } from "./core/session-checkpoints.js";
export { listSessionCheckpointRecords, previewSessionRewind, rewindSessionToCheckpoint } from "./core/checkpoint-admin.js";
export type { SessionRewindResult } from "./core/checkpoint-admin.js";
export type { SessionCheckpoint, SessionCheckpointDiff, SessionCheckpointPreview, SessionCheckpointRestore } from "./core/session-checkpoints.js";
export {
  forgetMemory,
  isProjectMemoryEnabled,
  listMemories,
  readMemoryContext,
  rememberFact,
  setProjectMemoryEnabled
} from "./core/memory-store.js";
export type { MemoryEntry } from "./core/memory-store.js";
export { installExtension, uninstallExtension, updateExtension } from "./extensions/extension-install.js";
export type { ExtensionCapabilitySummary, ExtensionInstallResult, InstallExtensionOptions, UninstallResult } from "./extensions/extension-install.js";
export { inspectExtension, setExtensionEnabled, setExtensionTrustTier, getExtensionTrustTier, validateExtensionPath } from "./extensions/extension-registry.js";
export { loadCrewCoderExtensions } from "./extensions/extension-loader.js";
export { addRegistry, removeRegistry, listConfiguredRegistries, searchRegistries } from "./extensions/extension-registry-index.js";
export type { RegistrySearchOptions, RegistrySearchResult } from "./extensions/extension-registry-index.js";
export type { LoadedCrewCoderExtension } from "./extensions/types.js";
export type { TrustTier } from "./core/trust.js";
export { startGoal, resumeGoal, pauseGoal, clearGoal, decideGoalApproval, refreshGoal, checkGoalCompletion } from "./core/goal-runner.js";
export { createGoal, loadGoal, listGoals, currentGoal, resolveGoal, saveGoal } from "./core/goal-store.js";
export type { CreateGoalInput, GoalCheckResult, GoalPendingApproval, GoalProgress, GoalRecord, GoalStatus } from "./core/goal-store.js";
