import { z } from "zod";

export const CrewCoderEventSchema = z.object({
  type: z.string()
}).passthrough();

export type CrewCoderJsonEvent = z.infer<typeof CrewCoderEventSchema>;

export function parseCrewCoderEvent(line: string): CrewCoderJsonEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  if (!trimmed.startsWith("{")) return undefined;
  return CrewCoderEventSchema.parse(JSON.parse(trimmed));
}

export function eventToText(event: CrewCoderJsonEvent): string {
  switch (event.type) {
    case "agent_start":
      return `session started: ${String(event.sessionId ?? "unknown")}`;
    case "crew_start":
      return `crew started: ${Array.isArray(event.workers) ? event.workers.join(", ") : "workers"}`;
    case "crew_worker_start":
      return `crew worker started: ${String(event.worker ?? "unknown")}`;
    case "crew_worker_end":
      return `crew worker ${event.status === "failed" ? "failed" : "completed"}: ${String(event.worker ?? "unknown")}`;
    case "crew_end":
      return `crew completed: ${String(event.completed ?? 0)}/${String(event.total ?? 0)} workers`;
    case "session_compaction_progress":
      return `compaction ${String(event.phase ?? "progress")}: ${String(event.message ?? "working…")}`;
    case "session_compacted":
      return `session compacted: ${String(event.originalMessageCount ?? "?")} -> ${String(event.retainedMessageCount ?? "?")} messages`;
    case "provider_start":
      return `provider started: ${String(event.providerId ?? event.provider ?? "unknown")}`;
    case "provider_end":
      return providerEndToText(event);
    case "provider_error":
      return `provider error: ${String(event.message ?? "unknown error")}`;
    case "backend_debug":
      return backendDebugToText(event);
    case "message_start":
      return "message started";
    case "message_end":
      return extractMessageText(event) || "message completed";
    case "assistant_delta":
      return String(event.text ?? "");
    case "thinking_delta":
      return String(event.text ?? "");
    case "tool_execution_start":
      return `tool started: ${String(event.toolName ?? "unknown")}`;
    case "tool_execution_end":
      return `tool ${event.isError ? "failed" : "completed"}: ${String(event.toolName ?? "unknown")}`;
    case "file_changed":
      return `changed: ${String(event.path ?? "unknown")}`;
    case "background_job_start":
      return `background job started: ${String(event.bgId ?? "unknown")}`;
    case "background_job_output":
      return String(event.text ?? "");
    case "background_job_status":
    case "background_job_end":
      return `background job ${String(event.status ?? "updated")}: ${String(event.bgId ?? "unknown")}`;
    case "approval_required":
      return `approval required: ${String(event.reason ?? event.toolName ?? "review action")}`;
    case "review_summary":
      return "review summary ready";
    case "validation_start":
      return `validation started: ${String(event.target ?? "validation")}`;
    case "validation_end":
      return `validation ${event.ok === false ? "failed" : "passed"}: ${String(event.target ?? "validation")}`;
    case "agent_error":
      return `agent error: ${String(event.message ?? "unknown error")}`;
    case "agent_end":
      return "agent completed";
    case "session_saved":
      return `session saved: ${String(event.sessionId ?? "unknown")}`;
    case "approval_resolved":
      return `approval ${event.approved === false ? "denied" : "approved"}`;
    case "extension_safety_policies":
      return `extension safety policies active: ${Array.isArray(event.policies) ? event.policies.length : 0}`;
    case "checkpoint_created":
      return `checkpoint created: ${String(event.checkpointId ?? "unknown")}`;
    case "checkpoint_restored":
      return `checkpoint restored: ${String(event.checkpointId ?? "unknown")} · restored ${String(event.restoredFiles ?? 0)} · deleted ${String(event.deletedFiles ?? 0)}`;
    case "extension_ui_notify":
      return `[${String(event.extensionId ?? "extension")}] ${String(event.message ?? "")}`;
    case "extension_ui_request":
      return `[${String(event.extensionId ?? "extension")}] ${String(event.title ?? "input requested")}`;
    case "extension_ui_resolved":
      return event.cancelled === true ? "extension prompt cancelled" : "extension prompt answered";
    case "stderr":
      return String(event.text ?? "");
    case "stdout":
      return String(event.text ?? "");
    case "process_exit":
      return `process exited: ${String(event.code ?? "unknown")}`;
    case "process_error":
      return `process error: ${String(event.message ?? "unknown error")}`;
    default:
      return JSON.stringify(event);
  }
}

function providerEndToText(event: CrewCoderJsonEvent): string {
  const usage = event.usage && typeof event.usage === "object" ? event.usage as Record<string, unknown> : undefined;
  const total = typeof usage?.totalTokens === "number" ? ` · ${Math.round(usage.totalTokens).toLocaleString("en-US")} tokens` : "";
  return `provider completed${total}`;
}

function backendDebugToText(event: CrewCoderJsonEvent): string {
  const source = String(event.source ?? "backend");
  const message = String(event.message ?? "debug event");
  const details = event.details && typeof event.details === "object" ? event.details as Record<string, unknown> : undefined;
  const preview = typeof details?.preview === "string" && details.preview ? `: ${details.preview}` : "";
  return `[${source}] ${message}${preview}`;
}

function extractMessageText(event: CrewCoderJsonEvent): string | undefined {
  const message = event.message as any;
  if (!message || !Array.isArray(message.content)) return undefined;
  const text = message.content
    .filter((part: any) => part?.type === "text")
    .map((part: any) => String(part.text ?? ""))
    .join("\n")
    .trim();
  return text || undefined;
}
