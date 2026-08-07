import { DEFAULT_EFFORT, type EffortLevel } from "./effort-levels.js";
import type { TuiUsageSummary } from "./usage.js";
import type { ImageAttachment } from "./image-attachment.js";
import type { CrewCoderLiveUiPermissions } from "../bridge/live-ui-protocol.js";

export type TuiMode = "general" | "plugin" | "extension";
export type TuiIntegrationProfile = "standalone" | "crewcode";

export const TUI_MODES: readonly TuiMode[] = ["general", "plugin", "extension"];
export const DEFAULT_TUI_MODE: TuiMode = "general";

export function isTuiMode(value: unknown): value is TuiMode {
  return value === "general" || value === "plugin" || value === "extension";
}

/**
 * Coerce a persisted mode (config `defaultMode`, saved session records) to a valid
 * TuiMode. The removed `auto` mode is still present in existing state on disk, so it
 * maps to the default instead of being ignored.
 */
export function normalizeTuiMode(value: unknown): TuiMode {
  if (typeof value !== "string") return DEFAULT_TUI_MODE;
  const lower = value.trim().toLowerCase();
  return isTuiMode(lower) ? lower : DEFAULT_TUI_MODE;
}
export type ToolStatus = "running" | "done" | "error";

export type TuiRendererMatch = {
  extensionId?: string;
  toolId?: string;
  renderer?: string;
  toolName?: string;
};

export type TuiRendererHook = {
  extensionId: string;
  id: string;
  title: string;
  target: "tool";
  match: TuiRendererMatch;
  template: string;
};

export type TuiDeclarativeComponent =
  | { kind: "markdown"; text: string }
  | { kind: "details"; items: Array<{ label: string; value: string }> }
  | { kind: "table"; columns: Array<{ key: string; label: string }>; rows: Array<Record<string, string | number | boolean | null | undefined>> }
  | { kind: "actionList"; actions: Array<{ id: string; label: string; description?: string }> };

export type TuiUiAction = { id: string; label: string; description?: string };

export type TuiSafetyPolicy = { extensionId: string; policyId: string; title: string; action: "allow" | "review" | "block"; reason?: string; tools: string[]; paths: string[]; commands: string[] };

export type TuiReviewIssueReference = { id: string; source: "branch" | "commit" | "status" | string; text: string; url?: string };

export type TuiReviewSummary = { branch?: string; clean: boolean; changedFiles: string[]; issueReferences: TuiReviewIssueReference[] };

/** Plain-language explanation of the agent's last decision, from `session why`. */
export type TuiDecisionExplanation = {
  explanation: string;
  /** `transcript` means the model explainer failed and this is a deterministic readout. */
  source: "model" | "transcript";
  fallbackReason?: string;
  toolCalls: string[];
  changedFiles: string[];
};

export type TuiCheckpoint ={ id: string; sessionId: string; reason: string; toolCallId?: string; toolName?: string; fileCount: number; totalBytes: number; truncated: boolean };

export type TuiCrewWorker = {
  name: string;
  status: "pending" | "running" | "completed" | "failed";
  sessionId?: string;
  error?: string;
};

export type TuiGoal = {
  id: string;
  objective: string;
  status: "queued" | "running" | "awaiting_approval" | "paused" | "completed" | "failed" | "cancelled";
  provider: string;
  model: string;
  cycle: number;
  maxTurns?: number;
  checkModel?: string;
  timeoutMinutes?: number;
  lastCheck?: { verdict: "continue" | "complete"; reason: string; evidence?: string; model: string };
  sessionId?: string;
  pauseReason?: string;
  error?: string;
  completionSummary?: string;
  completionEvidence?: string;
  pendingApproval?: { toolName: string; reason: string };
};

export type TuiEventBlock =
  | { type: "system"; text: string }
  | { type: "user"; text: string; background?: string[] }
  | { type: "assistant"; text: string; tokensPerSecond?: number }
  | { type: "thinking"; text: string }
  | { type: "compaction"; status: "running" | "done" | "skipped" | "failed"; percent: number; message: string; originalMessageCount?: number; retainedMessageCount?: number }
  | { type: "review_summary"; summary: TuiReviewSummary }
  | { type: "why"; decision: TuiDecisionExplanation }
  | { type: "goal"; goal: TuiGoal }
  | { type: "crew"; workers: TuiCrewWorker[]; completed: boolean }
  | { type: "checkpoint"; checkpointId: string; sessionId: string; reason: string; toolCallId?: string; toolName?: string; fileCount: number; totalBytes: number; truncated: boolean }
  | { type: "checkpoint_diff"; checkpointId: string; path: string; lines: string[]; truncated: boolean }
  | { type: "background_job"; bgId: string; command: string; status: "running" | "completed" | "failed" | "stopped"; output: string; exitCode?: number | null; startedAt?: string; endedAt?: string }
  | { type: "tool"; id?: string; name: string; status: ToolStatus; args?: Record<string, unknown>; text?: string; metadata?: Record<string, unknown> }
  | { type: "validation"; target: string; status: "running" | "passed" | "failed"; errors?: string[]; warnings?: string[] }
  | { type: "approval"; id?: string; toolCallId?: string; toolName?: string; risk?: string; text: string; args?: Record<string, unknown>; status: "pending" | "approved" | "denied"; resolutionReason?: string }
  | { type: "extension_ui"; requestId: string; extensionId: string; uiKind: "confirm" | "input" | "select" | "component"; title: string; message?: string; placeholder?: string; defaultValue?: string; options?: Array<{ label: string; value: string; description?: string }>; component?: TuiDeclarativeComponent; actions?: TuiUiAction[]; status: "pending" | "answered" | "cancelled"; answer?: string }
  | { type: "image"; attachment: ImageAttachment }
  | { type: "live_ui"; key: string; extensionId: string; contributionId: string; surface: string; status: "loading" | "ready" | "error" | "exited"; title: string }
  | { type: "error"; text: string };

export type TuiLiveUiFocus = {
  instanceId: string;
  key: string;
  extensionId: string;
  contributionId: string;
  surface: string;
  title: string;
  permissions: CrewCoderLiveUiPermissions;
};

export type TuiState = {
  cwd: string;
  remoteTarget?: string;
  gitLabel?: string;
  mode: TuiMode;
  integrationProfile: TuiIntegrationProfile;
  worker?: string;
  provider: string;
  model: string;
  systemPrompt?: string;
  effort: EffortLevel;
  thinkingEnabled: boolean;
  sessionId: string;
  /** Local or remote roots explicitly granted to this session. */
  externalDirectories: string[];
  input: string;
  inputCursor: number;
  attachments: ImageAttachment[];
  running: boolean;
  viewportScroll: number;
  viewportHeight: number;
  viewportMaxScroll: number;
  toolOutputExpanded: boolean;
  fullAccess: boolean;
  /** Opt-in per-session token budget applied to the next run. Undefined means unbounded. */
  tokenBudget?: number;
  allowExtensionLiveUi: boolean;
  usage: TuiUsageSummary;
  blocks: TuiEventBlock[];
  /** True once the active assistant turn has streamed text, so `message_end` must not re-render it. */
  streamedAssistantTurn?: boolean;
  /** Whether tracked file changes render in the right sidebar. */
  showFileChanges: boolean;
  changedFiles: string[];
  crewWorkers: TuiCrewWorker[];
  rendererHooks: TuiRendererHook[];
  safetyPolicies: TuiSafetyPolicy[];
  checkpoints: TuiCheckpoint[];
  liveUiFrames?: Map<string, string[]>;
  liveUiFocus?: TuiLiveUiFocus;
  liveUiContributions?: Array<{ extensionId: string; id: string; title: string; surface: string; slot?: string; entry: string; experimental: boolean; permissions: Record<string, unknown>; match?: Record<string, unknown>; activation?: Record<string, unknown>; allowed: boolean; blockedReasons: string[]; enabled: boolean; trusted: boolean }>;
};

export function shouldShowSystemLogs(): boolean {
  return process.env.CREWCODER_TUI_SYSTEM_LOGS === "1" || process.env.NODE_ENV === "development";
}

export function pushSystemLog(state: TuiState, text: string): void {
  if (shouldShowSystemLogs()) state.blocks.push({ type: "system", text });
}

export function createInitialState(): TuiState {
  return {
    cwd: process.cwd(),
    remoteTarget: undefined,
    gitLabel: undefined,
    mode: DEFAULT_TUI_MODE,
    integrationProfile: "standalone",
    worker: undefined,
    provider: process.env.CREWCODER_PROVIDER ?? "codex",
    model: process.env.CREWCODER_MODEL ?? "gpt-5.6-luna",
    systemPrompt: undefined,
    effort: DEFAULT_EFFORT,
    thinkingEnabled: true,
    sessionId: "new",
    externalDirectories: [],
    input: "",
    inputCursor: 0,
    attachments: [],
    running: false,
    viewportScroll: 0,
    viewportHeight: 1,
    viewportMaxScroll: 0,
    toolOutputExpanded: false,
    fullAccess: false,
    allowExtensionLiveUi: false,
    usage: { turns: 0 },
    blocks: [{ type: "system", text: "Tip: /help\n  Show help for interactive commands" }],
    showFileChanges: true,
    changedFiles: [],
    crewWorkers: [],
    rendererHooks: [],
    safetyPolicies: [],
    checkpoints: []
  };
}
