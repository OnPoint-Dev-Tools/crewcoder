/**
 * Translates CrewCoder `AgentEvent`s into ACP `session/update` payloads.
 *
 * Only events with a faithful ACP representation are translated; everything
 * else returns `undefined` and is dropped. CrewCoder's richer vocabulary
 * (checkpoints, cost ledger, goals, compaction) has no standard ACP shape and
 * is deferred to a future `_meta`/ext channel rather than being forced into a
 * lossy standard update.
 */
import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { AgentEvent } from "../core/events.js";
import type { ToolResultMessage } from "../core/messages.js";
import { toolKind, toolLocations, toolTitle } from "./tool-kind.js";

export type SessionUpdate = SessionNotification["update"];

export function translateEvent(event: AgentEvent): SessionUpdate | undefined {
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

  return undefined;
}

function resultText(result: ToolResultMessage): string {
  return result.content.map((part) => part.text).join("\n").trim();
}
