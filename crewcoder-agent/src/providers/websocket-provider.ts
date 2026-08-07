import type { AgentMessage, AssistantMessage, ToolCallPart } from "../core/messages.js";
import { getProviderApiKey } from "./auth-store.js";
import { toolParameters } from "../core/tool-schema.js";
import { normalizeUsage, type ModelUsage } from "../core/usage.js";
import type { ProviderRunInput, ProviderRunResult } from "./types.js";

const CLOSE_NORMAL = 1000;

export async function runWebSocketProvider(input: ProviderRunInput, signal?: AbortSignal): Promise<ProviderRunResult> {
  const startedAt = Date.now();
  const endpoint = input.provider.endpoint;
  if (!endpoint) throw new Error(`Provider ${input.provider.id} is missing WebSocket endpoint`);

  const model = input.model?.trim();
  if (!model || model === "default") throw new Error(`Provider ${input.provider.id} requires a concrete model`);

  const apiKey = await getProviderApiKey(input.provider);
  const request = buildWebSocketRequest(model, input, apiKey);

  await input.debug?.event({
    level: "info",
    source: "provider.websocket",
    message: "starting provider request",
    details: { providerId: input.provider.id, endpoint, model, inputItems: Array.isArray(request.input) ? request.input.length : 0, tools: request.tools?.length ?? 0 }
  });

  const output = await completeWebSocketRequest(endpoint, request, input, signal);

  await input.debug?.event({
    level: "info",
    source: "provider.websocket",
    message: "provider request finished",
    details: { providerId: input.provider.id, durationMs: Date.now() - startedAt, outputChars: output.text.length }
  });

  return {
    providerId: input.provider.id,
    text: output.text.trim() || "(no output)",
    stdout: output.text.trim(),
    stderr: "",
    exitCode: 0,
    timedOut: false,
    usage: output.usage
  };
}

type WebSocketRequest = {
  type: "request";
  model: string;
  prompt: string;
  instructions: string;
  input: unknown[];
  tools?: unknown[];
  cwd: string;
  stream: true;
  apiKey?: string;
  sessionId?: string;
  resumeFromSessionId?: string;
  continuation?: boolean;
  contextCache?: { enabled: true; key: string };
};

function buildWebSocketRequest(model: string, input: ProviderRunInput, apiKey?: string): WebSocketRequest {
  const modelInput = input.modelInput;
  const session = input.session ?? modelInput?.session;
  const request: WebSocketRequest = {
    type: "request",
    model,
    prompt: input.prompt,
    instructions: modelInput?.systemPrompt ?? "You are CrewCoder, a local coding agent CLI.",
    input: modelInput ? convertMessages(modelInput.messages) : [{ role: "user", content: input.prompt }],
    cwd: input.cwd,
    stream: true
  };

  if (apiKey) request.apiKey = apiKey;
  if (session) {
    request.sessionId = session.sessionId;
    request.continuation = session.continuation;
    request.contextCache = { enabled: true, key: session.resumeFromSessionId ?? session.sessionId };
    if (session.resumeFromSessionId) request.resumeFromSessionId = session.resumeFromSessionId;
  }
  if (modelInput?.availableTools.length) {
    request.tools = modelInput.availableTools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: toolParameters(tool),
      strict: false
    }));
  }

  return request;
}

function convertMessages(messages: AgentMessage[]): unknown[] {
  const items: unknown[] = [];
  // An orphaned `function_call_output` (its `function_call` truncated away by
  // compaction, branching, or a checkpoint restore) is a protocol error, so degrade
  // it to plain historical context instead of sending an unmatched call id.
  const pendingToolCallIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "user") items.push({ role: "user", content: textFromMessage(message) });
    else if (message.role === "assistant") {
      const text = textFromMessage(message);
      if (text.trim()) items.push({ role: "assistant", content: text });
      for (const part of message.content) {
        if (part.type !== "toolCall") continue;
        pendingToolCallIds.add(part.id);
        items.push({ type: "function_call", call_id: part.id, name: part.name, arguments: JSON.stringify(part.arguments) });
      }
    } else {
      const output = textFromMessage(message);
      if (!pendingToolCallIds.has(message.toolCallId)) {
        items.push({ role: "user", content: `Historical tool result from ${message.toolName}:\n${output}` });
        continue;
      }
      pendingToolCallIds.delete(message.toolCallId);
      items.push({ type: "function_call_output", call_id: message.toolCallId, output, is_error: message.isError });
    }
  }
  return items;
}

function textFromMessage(message: AgentMessage): string {
  return message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
}

async function completeWebSocketRequest(endpoint: string, request: unknown, input: ProviderRunInput, signal?: AbortSignal): Promise<{ text: string; usage?: ModelUsage }> {
  if (typeof WebSocket !== "function") throw new Error("WebSocket is not available in this Node runtime");

  const socket = new WebSocket(endpoint);
  const textParts: string[] = [];
  const toolCalls = new Map<string, { id: string; name: string; arguments: string }>();
  let completedResponse: unknown;
  let usage: ModelUsage | undefined;
  let done = false;

  return await new Promise<{ text: string; usage?: ModelUsage }>((resolve, reject) => {
    let pendingMessages = Promise.resolve();

    const cleanup = () => {
      signal?.removeEventListener("abort", abort);
      socket.removeEventListener("open", open);
      socket.removeEventListener("message", message);
      socket.removeEventListener("error", error);
      socket.removeEventListener("close", close);
    };

    const finish = () => {
      if (done) return;
      done = true;
      cleanup();
      if (completedResponse) mergeAssistantFromResponse(completedResponse, textParts, toolCalls);
      resolve({ text: buildAssistantJson(textParts, toolCalls, completedResponse), usage });
    };

    const abort = () => {
      cleanup();
      try { socket.close(CLOSE_NORMAL, "aborted"); } catch {}
      reject(new Error("Request was aborted"));
    };

    const open = () => {
      try {
        socket.send(JSON.stringify(request));
      } catch (sendError) {
        cleanup();
        reject(sendError);
      }
    };

    const message = (event: MessageEvent) => {
      pendingMessages = pendingMessages.then(async () => {
        const messageDone = await handleSocketData(event.data, textParts, toolCalls, input, (response) => { completedResponse = response; }, (nextUsage) => { usage = nextUsage; });
        if (messageDone) {
          try { socket.close(CLOSE_NORMAL, "done"); } catch {}
          finish();
        }
      }).catch((messageError: unknown) => {
        cleanup();
        reject(messageError);
      });
    };

    const error = () => {
      cleanup();
      reject(new Error(`WebSocket provider ${input.provider.id} failed`));
    };

    const close = () => { void pendingMessages.then(finish); };

    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
    socket.addEventListener("open", open);
    socket.addEventListener("message", message);
    socket.addEventListener("error", error);
    socket.addEventListener("close", close);
  });
}

async function handleSocketData(
  data: unknown,
  textParts: string[],
  toolCalls: Map<string, { id: string; name: string; arguments: string }>,
  input: ProviderRunInput,
  setCompletedResponse: (response: unknown) => void,
  setUsage: (usage: ModelUsage) => void
): Promise<boolean> {
  const text = await socketDataToText(data);
  if (!text.trim()) return false;

  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch {
    textParts.push(text);
    await input.stream?.onAssistantDelta?.(text);
    return false;
  }

  if (!isRecord(parsed)) return false;
  return await processSocketEvent(parsed, textParts, toolCalls, input, setCompletedResponse, setUsage);
}

async function socketDataToText(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof Uint8Array) return new TextDecoder().decode(data);
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (data instanceof Blob) return await data.text();
  return String(data);
}

async function processSocketEvent(
  event: Record<string, unknown>,
  textParts: string[],
  toolCalls: Map<string, { id: string; name: string; arguments: string }>,
  input: ProviderRunInput,
  setCompletedResponse: (response: unknown) => void,
  setUsage: (usage: ModelUsage) => void
): Promise<boolean> {
  const type = String(event.type ?? "");

  if ((type === "assistant_delta" || type === "response.output_text.delta") && typeof event.delta === "string") {
    textParts.push(event.delta);
    await input.stream?.onAssistantDelta?.(event.delta);
    return false;
  }

  if (type === "assistant_delta" && typeof event.text === "string") {
    textParts.push(event.text);
    await input.stream?.onAssistantDelta?.(event.text);
    return false;
  }

  if ((type === "thinking_delta" || isThinkingDeltaEvent(type)) && typeof event.delta === "string") {
    await input.stream?.onThinkingDelta?.(event.delta);
    return false;
  }

  if (type === "thinking_delta" && typeof event.text === "string") {
    await input.stream?.onThinkingDelta?.(event.text);
    return false;
  }

  if (type === "assistant_message" && typeof event.text === "string") {
    if (!textParts.join("").trim()) textParts.push(event.text);
    return false;
  }

  if (type === "tool_call" && typeof event.name === "string") {
    const id = toolCallId(event);
    toolCalls.set(id, { id, name: event.name, arguments: typeof event.arguments === "string" ? event.arguments : JSON.stringify(isRecord(event.arguments) ? event.arguments : {}) });
    return false;
  }

  if (type === "response.output_item.added" && isRecord(event.item) && (event.item.type === "function_call" || event.item.type === "tool_call")) {
    const id = toolCallId(event, event.item);
    toolCalls.set(id, { id, name: typeof event.item.name === "string" ? event.item.name : "", arguments: "" });
    return false;
  }

  if (isFunctionArgumentDeltaEvent(type) && typeof event.delta === "string") {
    const id = toolCallId(event);
    const existing = toolCalls.get(id) ?? { id, name: typeof event.name === "string" ? event.name : "", arguments: "" };
    existing.arguments += event.delta;
    toolCalls.set(id, existing);
    return false;
  }

  if (type === "response.output_item.done" && isRecord(event.item)) {
    const item = event.item;
    if ((item.type === "function_call" || item.type === "tool_call") && typeof item.name === "string") {
      const id = toolCallId(event, item);
      toolCalls.set(id, { id, name: item.name, arguments: typeof item.arguments === "string" ? item.arguments : toolCalls.get(id)?.arguments ?? "{}" });
    } else if (item.type === "message" && Array.isArray(item.content) && !textParts.join("").trim()) appendTextFromContentParts(item.content, textParts);
    return false;
  }

  if (type === "usage" || type === "usage_update") {
    const normalized = normalizeUsage(event.usage ?? event, input.provider.id, input.model);
    if (normalized) setUsage(normalized);
    return false;
  }

  if ((type === "response.completed" || type === "response.done") && isRecord(event.response)) {
    setCompletedResponse(event.response);
    const normalized = normalizeUsage(event.response.usage, input.provider.id, typeof event.response.model === "string" ? event.response.model : input.model);
    if (normalized) setUsage(normalized);
    return true;
  }

  return type === "done" || type === "complete" || type === "completed";
}

function buildAssistantJson(textParts: string[], toolCalls: Map<string, { id: string; name: string; arguments: string }>, completedResponse: unknown): string {
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
    content: content.length ? content : [{ type: "text", text: completedResponse ? JSON.stringify(completedResponse) : "(empty WebSocket response)" }],
    stopReason: toolCalls.size > 0 ? "tool_calls" : "end",
    timestamp: Date.now()
  };
  return JSON.stringify(assistant);
}

function mergeAssistantFromResponse(response: unknown, textParts: string[], toolCalls: Map<string, { id: string; name: string; arguments: string }>): void {
  const assistant = responseToAssistant(response);
  if (!textParts.join("").trim()) for (const part of assistant.content) if (part.type === "text") textParts.push(part.text);
  for (const part of assistant.content) if (part.type === "toolCall" && !toolCalls.has(part.id)) toolCalls.set(part.id, { id: part.id, name: part.name, arguments: JSON.stringify(part.arguments) });
}

function responseToAssistant(response: unknown): AssistantMessage {
  if (!isRecord(response)) return { role: "assistant", content: [{ type: "text", text: JSON.stringify(response) }], stopReason: "end", timestamp: Date.now() };
  const content: AssistantMessage["content"] = [];
  if (typeof response.output_text === "string" && response.output_text.trim()) content.push({ type: "text", text: response.output_text });
  if (Array.isArray(response.output)) {
    for (const item of response.output) {
      if (!isRecord(item)) continue;
      if (item.type === "message" && Array.isArray(item.content)) appendAssistantContent(item.content, content);
      if ((item.type === "function_call" || item.type === "tool_call") && typeof item.name === "string") {
        const id = typeof item.call_id === "string" ? item.call_id : typeof item.id === "string" ? item.id : `tool_${Date.now()}`;
        content.push({ type: "toolCall", id, name: item.name, arguments: parseJsonObject(typeof item.arguments === "string" ? item.arguments : "{}") } satisfies ToolCallPart);
      }
    }
  }
  return { role: "assistant", content: content.length ? content : [{ type: "text", text: JSON.stringify(response) }], stopReason: content.some((part) => part.type === "toolCall") ? "tool_calls" : "end", timestamp: Date.now() };
}

function appendAssistantContent(parts: unknown[], content: AssistantMessage["content"]): void {
  for (const part of parts) if (isRecord(part) && (part.type === "output_text" || part.type === "text") && typeof part.text === "string") content.push({ type: "text", text: part.text });
}

function appendTextFromContentParts(parts: unknown[], textParts: string[]): void {
  for (const part of parts) if (isRecord(part) && (part.type === "output_text" || part.type === "text") && typeof part.text === "string") textParts.push(part.text);
}

function isFunctionArgumentDeltaEvent(type: string): boolean {
  return type === "response.function_call_arguments.delta" || type === "response.tool_call_arguments.delta";
}

function isThinkingDeltaEvent(type: string): boolean {
  return type === "response.reasoning_text.delta"
    || type === "response.reasoning.delta"
    || type === "response.thinking.delta"
    || type === "response.reasoning_summary_text.delta"
    || type === "response.output_item.reasoning.delta";
}

function toolCallId(event: Record<string, unknown>, item?: Record<string, unknown>): string {
  return String(item?.call_id ?? item?.id ?? event.call_id ?? event.item_id ?? event.id ?? event.output_index ?? `tool_${Date.now()}`);
}

function parseJsonObject(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
