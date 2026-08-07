import fs from "node:fs";
import type { AgentMessage, AssistantMessage, ImagePart, ToolCallPart } from "../core/messages.js";
import { getProviderApiKey } from "./auth-store.js";
import { toolParameters } from "../core/tool-schema.js";
import { normalizeUsage, type ModelUsage } from "../core/usage.js";
import type { ProviderRunInput, ProviderRunResult } from "./types.js";
import { providerErrorMessage } from "./output-parser.js";
import { supportsParallelToolCalls } from "./model-resolution.js";

export async function runOpenAIResponsesProvider(input: ProviderRunInput, signal?: AbortSignal): Promise<ProviderRunResult> {
  const startedAt = Date.now();
  const endpoint = input.provider.endpoint ?? `${input.provider.baseUrl ?? "https://api.openai.com"}/v1/responses`;
  const apiKey = await getProviderApiKey(input.provider);
  if (!apiKey) throw new Error(`Provider ${input.provider.id} requires ${input.provider.apiKeyEnv ?? "OPENAI_API_KEY"}`);

  const model = input.model?.trim();
  if (!model || model === "default") throw new Error(`Provider ${input.provider.id} requires a concrete model`);

  const body = buildResponsesBody(model, input);

  await input.debug?.event({
    level: "info",
    source: "provider.openai_responses",
    message: "starting provider request",
    details: { providerId: input.provider.id, endpoint, model, inputItems: Array.isArray(body.input) ? body.input.length : 0, tools: body.tools?.length ?? 0 }
  });

  const response = await fetch(endpoint, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      ...(input.provider.headers ?? {})
    },
    body: JSON.stringify(body)
  });

  const contentType = response.headers.get("content-type") ?? "";
  const streamed = response.ok && contentType.includes("text/event-stream")
    ? await readOpenAIResponsesStream(response, signal, input.stream, input.provider.id, model)
    : undefined;
  const raw = streamed?.text ?? await response.text();
  const failed = !response.ok || Boolean(streamed?.error);
  const text = response.ok
    ? streamed?.error ?? streamed?.text ?? openAIResponseToCrewCoderAssistantJson(raw)
    : normalizeOpenAIResponsesError(raw, response.status, response.statusText);
  const usage = streamed?.usage ?? extractOpenAIUsage(raw, input.provider.id, model);

  await input.debug?.event({
    level: failed ? "error" : "info",
    source: "provider.openai_responses",
    message: "provider request finished",
    details: { providerId: input.provider.id, status: response.status, durationMs: Date.now() - startedAt, outputChars: text.length, ...(failed ? { error: providerErrorMessage(text) } : {}) }
  });

  return {
    providerId: input.provider.id,
    text: text.trim() || "(no output)",
    stdout: failed ? "" : text.trim(),
    stderr: failed ? text.trim() : "",
    exitCode: failed ? 1 : 0,
    timedOut: false,
    usage
  };
}

function buildResponsesBody(model: string, input: ProviderRunInput): { model: string; input: unknown[]; tools?: unknown[]; store: false; stream: true; parallel_tool_calls?: true } {
  const modelInput = input.modelInput;
  const body: { model: string; input: unknown[]; tools?: unknown[]; store: false; stream: true; parallel_tool_calls?: true } = {
    model,
    input: modelInput ? convertMessages(modelInput.messages, modelInput.systemPrompt) : [{ role: "user", content: input.prompt }],
    store: false,
    stream: true
  };

  if (modelInput?.availableTools.length) {
    body.parallel_tool_calls = supportsParallelToolCalls(input.provider, model) || undefined;
    body.tools = modelInput.availableTools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: toolParameters(tool),
      strict: false
    }));
  }

  return body;
}

function convertMessages(messages: AgentMessage[], systemPrompt: string): unknown[] {
  const items: unknown[] = [];
  const pendingToolCallIds = new Set<string>();
  if (systemPrompt.trim()) items.push({ role: "system", content: systemPrompt });

  for (const message of messages) {
    if (message.role === "user") {
      const imageParts = message.content.flatMap((part) => part.type === "image" ? [responsesImageBlock(part)] : []).filter((block): block is Record<string, unknown> => block !== undefined);
      if (imageParts.length) {
        // Responses API multimodal input: array of input_text / input_image parts.
        const parts: Array<Record<string, unknown>> = [];
        const text = textFromMessage(message);
        if (text.trim()) parts.push({ type: "input_text", text });
        parts.push(...imageParts);
        items.push({ role: "user", content: parts });
      } else {
        items.push({ role: "user", content: textFromMessage(message) });
      }
    } else if (message.role === "assistant") {
      const text = textFromMessage(message);
      if (text.trim()) items.push({ role: "assistant", content: text });
      for (const part of message.content) {
        if (part.type === "toolCall") {
          pendingToolCallIds.add(part.id);
          items.push({ type: "function_call", call_id: part.id, name: part.name, arguments: JSON.stringify(part.arguments) });
        }
      }
    } else {
      const output = textFromMessage(message);
      if (!pendingToolCallIds.has(message.toolCallId)) {
        items.push({ role: "user", content: `Historical tool result from ${message.toolName}:\n${output}` });
        continue;
      }
      pendingToolCallIds.delete(message.toolCallId);
      items.push({ type: "function_call_output", call_id: message.toolCallId, output });
    }
  }

  return items;
}

// Responses API image input: { type: "input_image", image_url: "data:<mime>;base64,<data>" }.
function responsesImageBlock(part: ImagePart): Record<string, unknown> | undefined {
  try {
    const data = fs.readFileSync(part.path).toString("base64");
    return { type: "input_image", image_url: `data:${part.mime};base64,${data}` };
  } catch {
    return undefined;
  }
}

function textFromMessage(message: AgentMessage): string {
  return message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
}

async function readOpenAIResponsesStream(response: Response, signal: AbortSignal | undefined, stream: ProviderRunInput["stream"] | undefined, providerId: string, model: string | undefined): Promise<{ text: string; usage?: ModelUsage; error?: string }> {
  if (!response.body) return { text: "" };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const textParts: string[] = [];
  const toolCalls = new Map<string, { id: string; name: string; arguments: string }>();
  let completedResponse: unknown;
  let streamError: string | undefined;
  let buffer = "";
  let emittedThinkingText = "";
  const emittedReasoningSummaries = new Set<string>();

  const emitThinking = async (delta: string) => {
    if (!delta) return;
    emittedThinkingText += delta;
    await stream?.onThinkingDelta?.(delta);
  };

  const emitReasoningSummary = async (summary: string) => {
    const normalized = normalizeReasoningText(summary);
    if (!normalized) return;
    const emitted = normalizeReasoningText(emittedThinkingText);
    if (emitted.includes(normalized) || emittedReasoningSummaries.has(normalized)) return;
    emittedReasoningSummaries.add(normalized);
    await emitThinking(`${summary}\n\n`);
  };

  const processEvent = async (event: Record<string, unknown>) => {
    const type = String(event.type ?? "");

    if (type === "error" || type === "response.failed" || type === "response.incomplete") {
      streamError = providerErrorMessage(JSON.stringify(isRecord(event.response) ? event.response : event));
      return;
    }

    if (type === "response.output_text.delta" && typeof event.delta === "string") {
      textParts.push(event.delta);
      await stream?.onAssistantDelta?.(event.delta);
      return;
    }

    if (type === "response.output_text.done" && typeof event.text === "string" && !textParts.join("").trim()) {
      textParts.push(event.text);
      return;
    }

    if (isThinkingDeltaEvent(type) && typeof event.delta === "string") {
      await emitThinking(event.delta);
      return;
    }

    if (isThinkingDeltaEvent(type) && isRecord(event.delta)) {
      const deltaText = collectReasoningTextToString(event.delta);
      if (deltaText) await emitThinking(deltaText);
      return;
    }

    if (isThinkingDoneEvent(type) && typeof event.text === "string") {
      await emitReasoningSummary(event.text);
      return;
    }

    if (type === "response.output_item.added" && isRecord(event.item) && (event.item.type === "function_call" || event.item.type === "tool_call")) {
      const id = toolCallId(event, event.item);
      toolCalls.set(id, { id, name: typeof event.item.name === "string" ? event.item.name : "", arguments: "" });
      return;
    }

    if (isFunctionArgumentDeltaEvent(type) && typeof event.delta === "string") {
      const id = toolCallId(event);
      const existing = toolCalls.get(id) ?? { id, name: typeof event.name === "string" ? event.name : "", arguments: "" };
      existing.arguments += event.delta;
      toolCalls.set(id, existing);
      return;
    }

    if (type === "response.output_item.done" && isRecord(event.item)) {
      const item = event.item;
      if ((item.type === "function_call" || item.type === "tool_call") && typeof item.name === "string") {
        const id = toolCallId(event, item);
        toolCalls.set(id, { id, name: item.name, arguments: typeof item.arguments === "string" ? item.arguments : toolCalls.get(id)?.arguments ?? "{}" });
      } else if (item.type === "reasoning") {
        const summary = extractReasoningSummaryText({ output: [item] });
        if (summary) await emitReasoningSummary(summary);
      } else if (item.type === "message" && Array.isArray(item.content) && !textParts.join("").trim()) {
        appendTextFromContentParts(item.content, textParts);
      }
      return;
    }

    if ((type === "response.content_part.done" || type === "response.output_text.done") && isRecord(event.part) && !textParts.join("").trim()) {
      appendTextFromContentParts([event.part], textParts);
      return;
    }

    if ((type === "response.completed" || type === "response.done") && isRecord(event.response)) completedResponse = event.response;
  };

  try {
    while (true) {
      if (signal?.aborted) throw new Error("Request was aborted");
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const data of sseDataLines(chunk)) {
          if (data === "[DONE]") continue;
          try { await processEvent(JSON.parse(data) as Record<string, unknown>); } catch {}
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      for (const data of sseDataLines(buffer)) {
        if (data === "[DONE]") continue;
        try { await processEvent(JSON.parse(data) as Record<string, unknown>); } catch {}
      }
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }

  if (streamError) return { text: streamError, error: streamError };

  if (completedResponse) {
    const finalThinking = extractReasoningSummaryText(completedResponse);
    if (finalThinking) await emitReasoningSummary(finalThinking);
    mergeAssistantFromResponse(completedResponse, textParts, toolCalls);
  }

  const content: AssistantMessage["content"] = [
    ...(textParts.join("").trim() ? [{ type: "text" as const, text: textParts.join("").trim() }] : []),
    ...Array.from(toolCalls.values()).filter((call) => call.name).map((call) => ({
      type: "toolCall" as const,
      id: call.id,
      name: call.name,
      arguments: parseJsonObject(call.arguments || "{}")
    }))
  ];

  const assistant: AssistantMessage = {
    role: "assistant",
    content: content.length ? content : [{ type: "text", text: completedResponse ? JSON.stringify(completedResponse) : "(empty OpenAI response)" }],
    stopReason: toolCalls.size > 0 ? "tool_calls" : "end",
    timestamp: Date.now()
  };
  return { text: JSON.stringify(assistant), usage: extractUsageFromResponse(completedResponse, providerId, model) };
}

function extractOpenAIUsage(raw: string, providerId: string, model?: string): ModelUsage | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return extractUsageFromResponse(parsed, providerId, model);
  } catch {
    return undefined;
  }
}

function extractUsageFromResponse(response: unknown, providerId: string, model?: string): ModelUsage | undefined {
  if (!isRecord(response)) return undefined;
  return normalizeUsage(response.usage, providerId, typeof response.model === "string" ? response.model : model);
}

function mergeAssistantFromResponse(response: unknown, textParts: string[], toolCalls: Map<string, { id: string; name: string; arguments: string }>): void {
  const assistant = openAIResponseToAssistant(JSON.stringify(response));
  if (!textParts.join("").trim()) {
    for (const part of assistant.content) if (part.type === "text") textParts.push(part.text);
  }
  for (const part of assistant.content) {
    if (part.type === "toolCall" && !toolCalls.has(part.id)) toolCalls.set(part.id, { id: part.id, name: part.name, arguments: JSON.stringify(part.arguments) });
  }
}

function sseDataLines(chunk: string): string[] {
  return chunk.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).filter(Boolean);
}

function appendTextFromContentParts(parts: unknown[], textParts: string[]): void {
  for (const part of parts) {
    if (isRecord(part) && (part.type === "output_text" || part.type === "text") && typeof part.text === "string") textParts.push(part.text);
  }
}

function openAIResponseToCrewCoderAssistantJson(raw: string): string {
  return JSON.stringify(openAIResponseToAssistant(raw));
}

function openAIResponseToAssistant(raw: string): AssistantMessage {
  try {
    const parsed = JSON.parse(raw) as { output_text?: string; output?: Array<Record<string, unknown>> };
    const content: AssistantMessage["content"] = [];

    if (typeof parsed.output_text === "string" && parsed.output_text.trim()) {
      content.push({ type: "text", text: parsed.output_text });
    }

    for (const item of parsed.output ?? []) {
      if (item.type === "message" && Array.isArray(item.content)) {
        for (const part of item.content as Array<Record<string, unknown>>) {
          if ((part.type === "output_text" || part.type === "text") && typeof part.text === "string") {
            content.push({ type: "text", text: part.text });
          }
        }
      }

      if ((item.type === "function_call" || item.type === "tool_call") && typeof item.name === "string") {
        const id = typeof item.call_id === "string" ? item.call_id : typeof item.id === "string" ? item.id : `tool_${Date.now()}`;
        content.push({
          type: "toolCall",
          id,
          name: item.name,
          arguments: parseJsonObject(typeof item.arguments === "string" ? item.arguments : "{}")
        } satisfies ToolCallPart);
      }
    }

    return {
      role: "assistant",
      content: content.length ? content : [{ type: "text", text: raw }],
      stopReason: content.some((part) => part.type === "toolCall") ? "tool_calls" : "end",
      timestamp: Date.now()
    };
  } catch {
    return { role: "assistant", content: [{ type: "text", text: raw }], stopReason: "end", timestamp: Date.now() };
  }
}

function normalizeOpenAIResponsesError(raw: string, status: number, statusText: string): string {
  const fallback = raw.trim() || statusText || "request failed";
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isRecord(parsed)) {
      const error = isRecord(parsed.error) ? parsed.error : parsed;
      const message = stringField(error, "message") ?? stringField(error, "detail") ?? stringField(error, "title") ?? fallback;
      const code = stringField(error, "code") ?? stringField(error, "type");
      return `OpenAI Responses API error (${status}${code ? `, ${code}` : ""}): ${message}`;
    }
  } catch {}
  return `OpenAI Responses API error (${status}): ${fallback}`;
}

function isFunctionArgumentDeltaEvent(type: string): boolean {
  return type === "response.function_call_arguments.delta" || type === "response.tool_call_arguments.delta";
}

function isThinkingDeltaEvent(type: string): boolean {
  return type === "response.reasoning_text.delta"
    || type === "response.reasoning.delta"
    || type === "response.reasoning_summary.delta"
    || type === "response.thinking.delta"
    || type === "response.reasoning_summary_text.delta"
    || type === "response.output_item.reasoning.delta";
}

function isThinkingDoneEvent(type: string): boolean {
  return type === "response.reasoning_text.done"
    || type === "response.reasoning_summary_text.done"
    || type === "response.reasoning_summary.done";
}

function extractReasoningSummaryText(response: unknown): string {
  if (!isRecord(response) || !Array.isArray(response.output)) return "";
  const parts: string[] = [];
  for (const item of response.output) {
    if (!isRecord(item) || item.type !== "reasoning") continue;
    collectReasoningText(item.summary, parts);
    collectReasoningText(item.content, parts);
    if (typeof item.text === "string") parts.push(item.text);
  }
  return [...new Set(parts.map((part) => part.trim()).filter(Boolean))].join("\n\n");
}

function collectReasoningText(value: unknown, parts: string[]): void {
  if (typeof value === "string") {
    parts.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectReasoningText(item, parts);
    return;
  }
  if (!isRecord(value)) return;
  if (typeof value.text === "string") parts.push(value.text);
  if (typeof value.summary === "string") parts.push(value.summary);
}

function collectReasoningTextToString(value: unknown): string {
  const parts: string[] = [];
  collectReasoningText(value, parts);
  return parts.join("");
}

function normalizeReasoningText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function toolCallId(event: Record<string, unknown>, item?: Record<string, unknown>): string {
  return String(item?.call_id ?? item?.id ?? event.call_id ?? event.item_id ?? event.output_index ?? `tool_${Date.now()}`);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function parseJsonObject(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
