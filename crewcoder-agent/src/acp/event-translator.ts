/**
 * Translates CrewCoder `AgentEvent`s into ACP `session/update` payloads.
 *
 * Standard events use ACP's portable update vocabulary. Compaction lifecycle
 * events use an additive `_crewcoder/*` update kind so capable hosts can render
 * truthful progress while other ACP clients safely ignore the unknown kind.
 * Everything else without a faithful representation returns `undefined`.
 */
import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { AgentEvent } from "../core/events.js";
import type { ToolResultMessage } from "../core/messages.js";
import { toolKind, toolLocations, toolTitle } from "./tool-kind.js";

export type SessionUpdate = SessionNotification["update"];

export interface CrewCoderCompactionUpdate {
  sessionUpdate: "_crewcoder/compaction_update";
  status: "started" | "completed" | "failed";
  automatic: boolean;
  phase?: "requested" | "summarizing" | "saving" | "skipped" | "failed";
  percent?: number;
  message: string;
  compactionId?: string;
  originalMessageCount?: number;
  retainedMessageCount?: number;
  /** Present only for host-requested compact, so CrewCode can replace local history. */
  summary?: string;
}

export type CrewCoderSessionUpdate = SessionUpdate | CrewCoderCompactionUpdate;

export function translateEvent(event: AgentEvent): CrewCoderSessionUpdate | undefined {
  if (event.type === "assistant_delta") {
    if (!event.text) return undefined;
    return { sessionUpdate: "agent_message_chunk", content: { type: "text", text: event.text } };
  }

  if (event.type === "thinking_delta") {
    if (!event.text) return undefined;
    return { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: event.text } };
  }

  if (event.type === "tool_execution_start") {
    return {
      sessionUpdate: "tool_call",
      toolCallId: event.toolCallId,
      title: toolTitle(event.toolName, event.args),
      kind: toolKind(event.toolName),
      status: "in_progress",
      rawInput: event.args,
      locations: toolLocations(event.args),
      _meta: { "crewcoder/tool": { name: event.toolName } }
    };
  }

  if (event.type === "tool_delta") {
    if (!event.text) return undefined;
    return {
      sessionUpdate: "tool_call_update",
      toolCallId: event.toolCallId,
      status: "in_progress",
      content: [{ type: "content", content: { type: "text", text: event.text } }]
    };
  }

  if (event.type === "tool_execution_end") {
    const output = resultText(event.result);
    const details = event.result.details;
    return {
      sessionUpdate: "tool_call_update",
      toolCallId: event.toolCallId,
      status: event.isError ? "failed" : "completed",
      rawOutput: {
        output,
        isError: event.isError,
        ...(details && Object.keys(details).length > 0 ? details : {})
      },
      content: output ? [{ type: "content", content: { type: "text", text: output } }] : undefined
    };
  }

  if (event.type === "session_compaction_progress") {
    return {
      sessionUpdate: "_crewcoder/compaction_update",
      status: event.phase === "failed" ? "failed" : event.phase === "skipped" ? "completed" : "started",
      automatic: event.automatic !== false,
      phase: event.phase,
      percent: event.percent,
      message: event.message,
      originalMessageCount: event.originalMessageCount,
      retainedMessageCount: event.retainedMessageCount
    };
  }

  if (event.type === "provider_compaction") {
    return {
      sessionUpdate: "_crewcoder/compaction_update",
      status: event.status,
      automatic: true,
      percent: event.percent ?? (event.status === "completed" ? 100 : undefined),
      message: event.message ?? (event.status === "started"
        ? `${event.providerId} is compacting its native context…`
        : event.status === "completed"
          ? `${event.providerId} compacted its native context. Continuing normally.`
          : `${event.providerId} native context compaction failed.`)
    };
  }

  if (event.type === "session_compacted") {
    const automatic = event.automatic !== false;
    return {
      sessionUpdate: "_crewcoder/compaction_update",
      status: "completed",
      automatic,
      percent: 100,
      message: "Context compacted. Continuing with the retained recent messages and summary.",
      compactionId: event.compactionId,
      originalMessageCount: event.originalMessageCount,
      retainedMessageCount: event.retainedMessageCount,
      ...(automatic ? {} : { summary: event.summary })
    };
  }

  return undefined;
}

function resultText(result: ToolResultMessage): string {
  return result.content.map((part) => part.text).join("\n").trim();
}
