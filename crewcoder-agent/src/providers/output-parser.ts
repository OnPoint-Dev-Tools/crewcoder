import type { AssistantMessage, ToolCallPart } from "../core/messages.js";
import { assistantText } from "../core/messages.js";

export type ProviderResponse =
  | { type: "assistant_text"; text: string }
  | { type: "tool_calls"; text?: string; calls: ToolCallPart[] }
  | { type: "error"; message: string; raw?: string };

export function parseProviderOutput(output: string): ProviderResponse {
  const trimmed = output.trim();
  if (!trimmed) return { type: "assistant_text", text: "(empty provider response)" };

  try {
    const parsed = JSON.parse(trimmed);
    const assistant = normalizeAssistantEnvelope(parsed);
    if (assistant) return assistant;
  } catch {
    // plain text provider output
  }

  return { type: "assistant_text", text: trimmed };
}

function normalizeAssistantEnvelope(parsed: unknown): ProviderResponse | undefined {
  const record = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : undefined;
  if (!record) return undefined;
  // Provider error envelopes must never be mistaken for assistant text; a
  // billing/auth failure rendered as a reply looks like a successful run.
  if (record.type === "error" || record.error !== undefined) {
    const message = extractErrorMessage(record);
    if (message) return { type: "error", message, raw: JSON.stringify(record) };
  }
  if (record.role === "assistant" && Array.isArray(record.content)) return responseFromContent(record.content);
  if (record.message && typeof record.message === "object") return normalizeAssistantEnvelope(record.message);
  if (Array.isArray(record.content)) return responseFromContent(record.content);
  if (Array.isArray(record.toolCalls) || Array.isArray(record.tool_calls)) {
    const calls = normalizeToolCalls((record.toolCalls ?? record.tool_calls) as unknown[]);
    const text = typeof record.text === "string" ? record.text : typeof record.content === "string" ? record.content : undefined;
    if (calls.length) return { type: "tool_calls", text, calls };
  }
  if (typeof record.text === "string") return { type: "assistant_text", text: record.text };
  if (typeof record.content === "string") return { type: "assistant_text", text: record.content };
  return undefined;
}

/**
 * Best-effort human-readable message from a provider error payload.
 * Falls back to the raw text so nothing is silently dropped.
 */
export function providerErrorMessage(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "Provider request failed with no error output.";
  try {
    const message = extractErrorMessage(JSON.parse(trimmed));
    if (message) return message;
  } catch {
    // non-JSON provider error output
  }
  return trimmed;
}

function extractErrorMessage(parsed: unknown): string | undefined {
  if (!isRecord(parsed)) return undefined;
  const error = parsed.error;
  if (typeof error === "string" && error.trim()) return error.trim();
  if (isRecord(error)) {
    const message = typeof error.message === "string" ? error.message.trim() : "";
    const type = typeof error.type === "string" ? error.type.trim() : "";
    if (message) return type ? `${type}: ${message}` : message;
    if (type) return type;
  }
  if (typeof parsed.message === "string" && parsed.message.trim()) return parsed.message.trim();
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function responseFromContent(content: unknown[]): ProviderResponse {
  const calls = content.filter(isToolCallPart);
  const text = content
    .filter((part): part is { type: "text"; text: string } => Boolean(part && typeof part === "object" && (part as any).type === "text" && typeof (part as any).text === "string"))
    .map((part) => part.text)
    .join("\n");
  if (calls.length) return { type: "tool_calls", text, calls };
  return { type: "assistant_text", text };
}

function normalizeToolCalls(calls: unknown[]): ToolCallPart[] {
  return calls.flatMap((call, index) => {
    const record = call && typeof call === "object" ? call as Record<string, unknown> : undefined;
    if (!record) return [];
    const name = typeof record.name === "string" ? record.name : typeof record.function === "object" && record.function && typeof (record.function as any).name === "string" ? (record.function as any).name : undefined;
    if (!name) return [];
    const rawArgs = record.arguments ?? (typeof record.function === "object" && record.function ? (record.function as any).arguments : undefined);
    return [{
      type: "toolCall" as const,
      id: typeof record.id === "string" ? record.id : `tool_${index}`,
      name,
      arguments: normalizeArguments(rawArgs)
    }];
  });
}

function normalizeArguments(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {}
  }
  return {};
}

function isToolCallPart(part: unknown): part is ToolCallPart {
  return Boolean(part && typeof part === "object" && (part as any).type === "toolCall" && typeof (part as any).name === "string" && typeof (part as any).id === "string");
}

export function providerResponseToAssistantMessage(response: ProviderResponse): AssistantMessage {
  if (response.type === "error") return { ...assistantText(response.message, "error"), errorMessage: response.message };
  if (response.type === "assistant_text") return assistantText(response.text, "end");
  return {
    role: "assistant",
    content: [
      ...(response.text ? [{ type: "text" as const, text: response.text }] : []),
      ...response.calls
    ],
    stopReason: "tool_calls",
    timestamp: Date.now()
  };
}
