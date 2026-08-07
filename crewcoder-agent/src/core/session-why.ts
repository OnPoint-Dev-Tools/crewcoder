import type { AgentMessage, AssistantMessage, ToolCallPart } from "./messages.js";
import { getText, textMessage } from "./messages.js";
import type { ModelClient } from "./model-client.js";
import type { SessionRecord } from "./session-store.js";

export type DecisionToolCall = {
  name: string;
  arguments: Record<string, unknown>;
  /** Undefined when the run ended before the tool produced a result. */
  ok?: boolean;
  result?: string;
};

/** The last thing the agent actually did, reconstructed from the durable transcript. */
export type SessionDecision = {
  sessionId: string;
  /** Index of the assistant message in `record.messages`, so callers can point at it. */
  messageIndex: number;
  /** The user turn that led to the decision, when there is one. */
  request?: string;
  /** The assistant's own words. Empty when the turn was tool calls only. */
  assistantText: string;
  stopReason: AssistantMessage["stopReason"];
  errorMessage?: string;
  toolCalls: DecisionToolCall[];
  changedFiles: string[];
};

export type SessionWhy = {
  decision: SessionDecision;
  explanation: string;
  /** `transcript` means the model call failed and this is the deterministic fallback. */
  source: "model" | "transcript";
  /** Set only when `source` is `transcript`, so a degraded explanation is never silent. */
  fallbackReason?: string;
};

const MAX_REQUEST_CHARS = 1200;
const MAX_ASSISTANT_CHARS = 4000;
const MAX_TOOL_RESULT_CHARS = 600;
const MAX_ARGUMENT_CHARS = 400;
const MAX_EXPLANATION_CHARS = 4000;
const MAX_TOOL_CALLS = 12;
const MAX_CHANGED_FILES = 20;

const WHY_SYSTEM_PROMPT = [
  "You are explaining a coding agent's most recent decision to the user who is watching it work.",
  "You are given that decision verbatim: their request, what the agent said, the tools it ran, and the files it touched.",
  "Explain, in plain language a busy engineer can skim:",
  "1. What the agent decided to do.",
  "2. Why that follows from the request and from what the tools actually returned.",
  "3. What it deliberately did not do, or any assumption it made that could be wrong.",
  "Rules: 4-8 short bullet points, no preamble, no markdown headings, no code blocks.",
  "Ground every claim in the evidence provided. If the evidence does not explain the choice, say so plainly instead of inventing a rationale.",
  "Do not propose next steps, do not write code, and do not request tools."
].join("\n");

/**
 * Reconstruct the agent's last decision: its final assistant turn plus the tool
 * calls and results attached to it. Returns undefined for a session that never
 * produced an assistant turn with content.
 */
export function extractLastDecision(record: SessionRecord): SessionDecision | undefined {
  const messages = record.messages;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message || message.role !== "assistant") continue;
    const assistantText = getText(message).trim();
    const toolCallParts = message.content.filter((part): part is ToolCallPart => part.type === "toolCall");
    if (!assistantText && !toolCallParts.length && message.stopReason !== "error") continue;
    return {
      sessionId: record.id,
      messageIndex: index,
      request: findRequest(messages, index),
      assistantText: truncate(assistantText, MAX_ASSISTANT_CHARS),
      stopReason: message.stopReason,
      errorMessage: message.errorMessage,
      toolCalls: collectToolCalls(messages, index, toolCallParts),
      changedFiles: [...new Set(record.mutationLog ?? [])].slice(0, MAX_CHANGED_FILES)
    };
  }
  return undefined;
}

/**
 * Ask the model to explain its last decision in plain language. The model never
 * sees tools here — this is an explanation of work already done, not more work.
 * A failed model call degrades to a deterministic transcript readout rather than
 * throwing, but always reports why.
 */
export async function explainLastDecision(
  record: SessionRecord,
  options: { modelClient: ModelClient; signal?: AbortSignal }
): Promise<SessionWhy | undefined> {
  const decision = extractLastDecision(record);
  if (!decision) return undefined;
  const evidence = formatDecisionEvidence(decision);
  try {
    const assistant = await options.modelClient.complete(
      {
        systemPrompt: WHY_SYSTEM_PROMPT,
        messages: [textMessage("user", evidence)],
        availableTools: []
      },
      options.signal
    );
    // Provider failures arrive as an error-stopReason message rather than a throw.
    if (assistant.stopReason === "error") {
      return fallback(decision, assistant.errorMessage?.trim() || "The provider returned an error while explaining the decision.");
    }
    const text = getText(assistant).trim();
    if (!text) return fallback(decision, "The provider returned an empty explanation.");
    return { decision, explanation: truncate(text, MAX_EXPLANATION_CHARS), source: "model" };
  } catch (error) {
    return fallback(decision, error instanceof Error ? error.message : String(error));
  }
}

/** The exact evidence handed to the model. Exported so the CLI can show it with --show-evidence. */
export function formatDecisionEvidence(decision: SessionDecision): string {
  const lines: string[] = [];
  lines.push(decision.request ? `The user asked:\n${decision.request}` : "The user's request is not available in the transcript.");
  lines.push("", decision.assistantText ? `The agent replied:\n${decision.assistantText}` : "The agent produced no text on this turn; it only ran tools.");
  if (decision.stopReason === "error") lines.push("", `The turn ended with a provider error: ${decision.errorMessage ?? "unknown error"}`);
  if (decision.stopReason === "aborted") lines.push("", "The turn was aborted before it finished.");
  if (decision.toolCalls.length) {
    lines.push("", "Tools it ran on this turn:");
    for (const call of decision.toolCalls) {
      const status = call.ok === undefined ? "no result recorded" : call.ok ? "succeeded" : "failed";
      lines.push(`- ${call.name}(${formatArguments(call.arguments)}) — ${status}`);
      if (call.result) lines.push(`  result: ${call.result}`);
    }
  } else {
    lines.push("", "It ran no tools on this turn.");
  }
  if (decision.changedFiles.length) {
    lines.push("", `Files changed in this session so far: ${decision.changedFiles.join(", ")}`);
  }
  return lines.join("\n");
}

/**
 * Deterministic explanation used when the model call fails. It states only what
 * the transcript proves, so a degraded answer reads as a readout rather than
 * passing itself off as reasoning.
 */
export function describeDecision(decision: SessionDecision): string {
  const lines: string[] = [];
  if (decision.assistantText) lines.push(`- The agent said: ${firstLine(decision.assistantText)}`);
  if (decision.stopReason === "error") lines.push(`- The turn failed with a provider error: ${decision.errorMessage ?? "unknown error"}`);
  if (decision.stopReason === "aborted") lines.push("- The turn was aborted before it finished.");
  for (const call of decision.toolCalls) {
    const status = call.ok === undefined ? "no result recorded" : call.ok ? "succeeded" : "failed";
    lines.push(`- It ran ${call.name}(${formatArguments(call.arguments)}) — ${status}`);
  }
  if (!decision.toolCalls.length) lines.push("- It ran no tools on this turn.");
  if (decision.changedFiles.length) lines.push(`- Files changed in this session: ${decision.changedFiles.join(", ")}`);
  return lines.join("\n");
}

function fallback(decision: SessionDecision, fallbackReason: string): SessionWhy {
  return { decision, explanation: describeDecision(decision), source: "transcript", fallbackReason };
}

function findRequest(messages: AgentMessage[], assistantIndex: number): string | undefined {
  for (let index = assistantIndex - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message || message.role !== "user") continue;
    const text = getText(message).trim();
    if (text) return truncate(text, MAX_REQUEST_CHARS);
  }
  return undefined;
}

function collectToolCalls(messages: AgentMessage[], assistantIndex: number, parts: ToolCallPart[]): DecisionToolCall[] {
  return parts.slice(0, MAX_TOOL_CALLS).map((part) => {
    const result = findToolResult(messages, assistantIndex, part.id);
    return {
      name: part.name,
      arguments: part.arguments,
      ...(result ? { ok: !result.isError, result: truncate(getText(result).replace(/\s+/g, " ").trim(), MAX_TOOL_RESULT_CHARS) } : {})
    };
  });
}

function findToolResult(messages: AgentMessage[], assistantIndex: number, toolCallId: string) {
  for (let index = assistantIndex + 1; index < messages.length; index++) {
    const message = messages[index];
    if (message?.role === "toolResult" && message.toolCallId === toolCallId) return message;
  }
  return undefined;
}

function formatArguments(args: Record<string, unknown>): string {
  const entries = Object.entries(args).map(([key, value]) => `${key}: ${formatValue(value)}`);
  return truncate(entries.join(", "), MAX_ARGUMENT_CHARS);
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (value === null || value === undefined) return String(value);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((candidate) => candidate.trim())?.trim() ?? text;
  return truncate(line, 240);
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}
