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
  automatic: true;
  phase?: "requested" | "summarizing" | "saving" | "skipped" | "failed";
  percent?: number;
  message: string;
  compactionId?: string;
  originalMessageCount?: number;
  retainedMessageCount?: number;
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
      locations: toolLocations(event.args)
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
    return {
      sessionUpdate: "tool_call_update",
      toolCallId: event.toolCallId,
      status: event.isError ? "failed" : "completed",
      rawOutput: { output, isError: event.isError },
      content: output ? [{ type: "content", content: { type: "text", text: output } }] : undefined
    };
  }

  if (event.type === "session_compaction_progress") {
    return {
      sessionUpdate: "_crewcoder/compaction_update",
      status: event.phase === "failed" ? "failed" : event.phase === "skipped" ? "completed" : "started",
      automatic: true,
      phase: event.phase,
      percent: event.percent,
      message: event.message,
      originalMessageCount: event.originalMessageCount,
      retainedMessageCount: event.retainedMessageCount
    };
  }

  if (event.type === "session_compacted") {
    return {
      sessionUpdate: "_crewcoder/compaction_update",
      status: "completed",
      automatic: true,
      percent: 100,
      message: "Context compacted. Continuing with the retained recent messages and summary.",
      compactionId: event.compactionId,
      originalMessageCount: event.originalMessageCount,
      retainedMessageCount: event.retainedMessageCount
    };
  }

  return undefined;
}

function resultText(result: ToolResultMessage): string {
  return result.content.map((part) => part.text).join("\n").trim();
}
