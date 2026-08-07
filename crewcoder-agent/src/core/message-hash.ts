import { createHash } from "node:crypto";
import type { AssistantMessage } from "./messages.js";
import type { ModelInput } from "./model-client.js";

export type MessageHashes = { id: string; promptHash: string; responseHash: string };

export function hashModelInput(input: ModelInput): string {
  return sha256(stableJson(input));
}

export function hashAssistantResponse(message: AssistantMessage): string {
  return sha256(stableJson({ role: message.role, content: message.content, stopReason: message.stopReason, errorMessage: message.errorMessage }));
}

export function assignAssistantHashes(message: AssistantMessage, input: ModelInput): AssistantMessage {
  const promptHash = hashModelInput(input);
  const responseHash = hashAssistantResponse(message);
  const id = `pr_${sha256(`${promptHash}:${responseHash}`).slice(0, 20)}`;
  return { ...message, id, promptHash, responseHash };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, sortValue(item)]));
}
