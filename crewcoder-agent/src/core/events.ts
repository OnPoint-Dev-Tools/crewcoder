import type { AgentMessage, AssistantMessage, ToolResultMessage } from "./messages.js";
import type { CrewCoderExtUiAction, CrewCoderExtUiComponent } from "../extensions/api.js";
import type { BackendDebugEvent } from "./backend-debug-logger.js";
import type { ModelUsage, UsageSummary } from "./usage.js";

export type ApprovalRisk = "safe" | "review" | "dangerous";

export type AgentEvent =
  | { type: "agent_start"; sessionId: string }
  | { type: "crew_start"; workers: string[] }
  | { type: "crew_worker_start"; worker: string; index: number; total: number; sessionId?: string }
  | { type: "crew_worker_end"; worker: string; index: number; total: number; status: "completed" | "failed"; sessionId?: string; error?: string }
  | { type: "crew_end"; total: number; completed: number; failed: number }
  | { type: "session_compaction_progress"; phase: "requested" | "summarizing" | "saving" | "skipped" | "failed"; percent: number; message: string; originalMessageCount?: number; retainedMessageCount?: number }
  | { type: "session_compaction_preview"; previewId: string; summary: string; source: "model" | "deterministic"; originalMessageCount: number; retainedMessageCount: number }
  | { type: "session_compacted"; compactionId: string; originalMessageCount: number; retainedMessageCount: number; summary: string }
  | BackendDebugEvent
  | { type: "agent_error"; sessionId?: string; message: string; stack?: string }
  | { type: "agent_stalled"; sessionId: string; reason: string; toolName: string }
  | { type: "provider_start"; providerId: string; model?: string }
  | { type: "provider_end"; providerId: string; model?: string; exitCode?: number | null; timedOut?: boolean; usage?: ModelUsage }
  | { type: "provider_error"; providerId: string; model?: string; message: string }
  | { type: "turn_start"; iteration: number }
  | { type: "message_start"; message: AgentMessage }
  | { type: "assistant_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "usage_update"; usage: ModelUsage; summary: UsageSummary }
  | { type: "token_budget_warning"; limit: number; used: number; remaining: number; percent: number }
  | { type: "token_budget_exceeded"; sessionId: string; limit: number; used: number; percent: number; handoffSummary: string }
  | { type: "message_end"; message: AgentMessage; durationMs?: number; outputTokens?: number }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: Record<string, unknown>; metadata?: Record<string, unknown> }
  | { type: "tool_delta"; toolCallId: string; toolName: string; text: string; metadata?: Record<string, unknown> }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: ToolResultMessage; isError: boolean; metadata?: Record<string, unknown> }
  | { type: "file_changed"; path: string; toolName: string }
  | { type: "background_job_start"; bgId: string; command: string; cwd: string; startedAt: string }
  | { type: "background_job_output"; bgId: string; text: string }
  | { type: "background_job_status"; bgId: string; command: string; status: "running" | "completed" | "failed" | "stopped"; output: string; exitCode?: number | null; startedAt: string; endedAt?: string }
  | { type: "background_job_end"; bgId: string; status: "completed" | "failed" | "stopped"; exitCode: number | null; signal?: string; endedAt: string }
  | { type: "approval_required"; approvalId: string; toolCallId: string; toolName: string; risk: ApprovalRisk; reason: string; args: Record<string, unknown> }
  | { type: "approval_resolved"; approvalId: string; approved: boolean; reason?: string }
  | { type: "extension_safety_policies"; policies: Array<{ extensionId: string; policyId: string; title: string; action: "allow" | "review" | "block"; reason?: string; tools: string[]; paths: string[]; commands: string[] }> }
  | { type: "checkpoint_created"; checkpointId: string; sessionId: string; reason: string; toolCallId?: string; toolName?: string; fileCount: number; totalBytes: number; truncated: boolean }
  | { type: "checkpoint_restored"; checkpointId: string; sessionId: string; restoredFiles: number; deletedFiles: number; restoredAt: string }
  | { type: "extension_ui_notify"; extensionId: string; message: string; level: "info" | "success" | "warning" | "error" }
  | { type: "extension_ui_request"; requestId: string; extensionId: string; uiKind: "confirm" | "input" | "select" | "component"; title: string; message?: string; placeholder?: string; defaultValue?: string; options?: Array<{ label: string; value: string; description?: string }>; component?: CrewCoderExtUiComponent; actions?: CrewCoderExtUiAction[] }
  | { type: "extension_ui_resolved"; requestId: string; cancelled: boolean }
  | { type: "validation_start"; target: string }
  | { type: "validation_end"; target: string; ok: boolean; errors?: string[]; warnings?: string[] }
  | { type: "verification_start"; checks: string[] }
  | { type: "verification_end"; ok: boolean; checks: Array<{ id: string; title: string; ok: boolean; output: string; durationMs: number }> }
  | { type: "turn_end"; iteration: number; message: AssistantMessage; toolResults: ToolResultMessage[] }
  | { type: "session_saved"; sessionId: string; path: string }
  | { type: "agent_end"; sessionId: string; messages: AgentMessage[] };

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;
