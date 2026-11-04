import type { ModelStreamCallbacks } from "../core/model-client.js";

type ElicitationResult = { action: "accept" | "decline" | "cancel"; content: Record<string, unknown> | null };

export async function answerCodexMcpElicitation(
  params: Record<string, unknown>,
  requestQuestion: ModelStreamCallbacks["requestQuestion"],
  signal?: AbortSignal
): Promise<ElicitationResult> {
  if (!requestQuestion || signal?.aborted) return { action: "cancel", content: null };
  const schema = params.requestedSchema;
  const form = params.mode === "form" || params.mode === "openai/form";
  if (!form && params.mode !== "url") throw new Error("Unsupported Codex MCP elicitation mode");
  const consentOnly = form && isRecord(schema) && schema.type === "object"
    && isRecord(schema.properties) && Object.keys(schema.properties).length === 0
    && (!Array.isArray(schema.required) || schema.required.length === 0);
  const needsInput = form && !consentOnly;
  const answer = await requestQuestion({
    kind: needsInput ? "question" : "permission",
    signal,
    title: [
      `MCP request: ${String(params.serverName ?? "tool")}`,
      typeof params.message === "string" ? params.message : "Tool access requested",
      params.mode === "url" ? String(params.url ?? "") : needsInput ? JSON.stringify(schema, null, 2) : ""
    ].filter(Boolean).join("\n\n"),
    ...(needsInput
      ? { placeholder: "Enter the requested form as a JSON object" }
      : { options: [{ label: "Allow once", value: "accept" }, { label: "Decline", value: "decline" }] })
  });
  // A late answer cannot authorize a turn that has already stopped.
  if (signal?.aborted || answer === undefined) return { action: "cancel", content: null };
  if (!needsInput) return answer === "accept"
    ? { action: "accept", content: consentOnly ? {} : null }
    : { action: "decline", content: null };
  let content: unknown;
  try { content = JSON.parse(answer); } catch { /* Invalid input must not become consent. */ }
  if (!isRecord(content)) throw new Error("MCP form response must be a JSON object matching the displayed schema");
  return { action: "accept", content };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
