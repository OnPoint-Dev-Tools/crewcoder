import fs from "node:fs";
import type { AgentMessage, AssistantMessage, ImagePart, ToolCallPart } from "../core/messages.js";
import { getProviderAuth } from "./auth-store.js";
import { toolParameters } from "../core/tool-schema.js";
import { normalizeUsage, type ModelUsage } from "../core/usage.js";
import type { CodexOAuthCredentials } from "./oauth-codex.js";
import type { ProviderRunInput, ProviderRunResult } from "./types.js";
import { providerErrorMessage } from "./output-parser.js";
import { CREWCODER_VERSION } from "../core/version.js";
import { disableCodexWebSocketSession, isCodexWebSocketSessionDisabled, requestCodexWebSocket, type CodexWebSocketRequest } from "./codex-websocket-transport.js";
import { runCodexAppServerProvider } from "./codex-app-server-provider.js";

const DEFAULT_CODEX_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
const MAX_CODEX_RETRY_ATTEMPTS = 3;
const CODEX_LARGE_REQUEST_BYTES = 512 * 1024;
// Large stateless Responses requests can be reset briefly by the upstream edge.
// Spread retries beyond that reset window instead of replaying all three in ~1.5s.
const CODEX_RETRY_BASE_MS = 1_500;

export async function runCodexProvider(input: ProviderRunInput, signal?: AbortSignal): Promise<ProviderRunResult> {
  // Official Codex durable threads survive CrewCoder and machine restarts. Older
  // credentials without an id_token safely retain the direct Responses transport
  // until the user signs in again and app-server can own the thread store.
  const durable = await runCodexAppServerProvider(input, signal);
  if (durable) return durable;
  const startedAt = Date.now();
  const endpoint = input.provider.endpoint ?? DEFAULT_CODEX_ENDPOINT;
  const auth = await getProviderAuth(input.provider);
  if (!auth) throw new Error("Provider codex requires OAuth login. Run: crewcoder login codex");

  const credential = auth.credential;
  if (credential?.type !== "oauth") throw new Error("Provider codex requires ChatGPT subscription OAuth. Run: crewcoder login codex");

  const model = input.model?.trim();
  if (!model || model === "default") throw new Error("Provider codex requires a concrete model");

  const body = buildCodexBody(model, input);
  const serializedBody = JSON.stringify(body);
  const requestBytes = Buffer.byteLength(serializedBody);
  const headers = buildCodexHeaders(auth.token, credential, input.provider.headers, input.session);

  await input.debug?.event({
    level: "info",
    source: "provider.codex",
    message: "starting provider request",
    details: { providerId: input.provider.id, endpoint, model, inputItems: Array.isArray(body.input) ? body.input.length : 0, tools: body.tools?.length ?? 0, requestBytes }
  });

  const requestInit: RequestInit = { method: "POST", signal, headers, body: serializedBody };
  let webSocketRequest: CodexWebSocketRequest | undefined;
  let response: Response;
  if (endpoint === DEFAULT_CODEX_ENDPOINT && input.session?.sessionId && !isCodexWebSocketSessionDisabled(input.session.sessionId)) {
    try {
      webSocketRequest = await requestCodexWebSocket({ endpoint, headers, body, sessionId: input.session.sessionId, signal });
      response = webSocketRequest.response;
    } catch (error) {
      if (signal?.aborted) throw error;
      disableCodexWebSocketSession(input.session.sessionId);
      await input.debug?.event({
        level: "warn",
        source: "provider.codex",
        message: "Codex WebSocket unavailable; falling back to SSE",
        details: { providerId: input.provider.id, error: describeTransportError(error), requestBytes }
      });
      response = await fetchCodexWithRetries(endpoint, requestInit, input);
    }
  } else {
    response = await fetchCodexWithRetries(endpoint, requestInit, input);
  }

  let streamed: Awaited<ReturnType<typeof readCodexStream>> | undefined;
  try {
    streamed = response.ok ? await readCodexStream(response, signal, input.stream, input.provider.id, model) : undefined;
  } catch (error) {
    if (!webSocketRequest || signal?.aborted) {
      webSocketRequest?.discard();
      throw error;
    }
    const streamingStarted = webSocketRequest.started();
    webSocketRequest.discard();
    if (input.session?.sessionId) disableCodexWebSocketSession(input.session.sessionId);
    if (streamingStarted) throw error;
    webSocketRequest = undefined;
    await input.debug?.event({
      level: "warn",
      source: "provider.codex",
      message: "Codex WebSocket failed before streaming; falling back to SSE",
      details: { providerId: input.provider.id, error: describeTransportError(error), requestBytes }
    });
    response = await fetchCodexWithRetries(endpoint, requestInit, input);
    streamed = response.ok ? await readCodexStream(response, signal, input.stream, input.provider.id, model) : undefined;
  }
  if (webSocketRequest) {
    if (streamed?.error) webSocketRequest.discard();
    else webSocketRequest.commit(streamed?.responseId, streamed?.assistant ? convertMessages([streamed.assistant]) : []);
  }
  const raw = streamed?.text ?? await response.text();
  const failed = !response.ok || Boolean(streamed?.error);
  const text = response.ok
    ? streamed?.error ?? normalizeCodexSuccess(raw)
    : normalizeCodexError(raw, response.status, response.statusText);
  const usage = streamed?.usage ?? extractCodexUsage(raw, input.provider.id, model);

  await input.debug?.event({
    level: failed ? "error" : "info",
    source: "provider.codex",
    message: "provider request finished",
    details: { providerId: input.provider.id, transport: webSocketRequest ? "websocket" : "sse", status: response.status, durationMs: Date.now() - startedAt, outputChars: text.length, ...(streamed?.error ? { error: streamed.error } : {}) }
  });

  const finalText = response.ok && !streamed?.error ? normalizeCodexSuccess(text) : text;
  return {
    providerId: input.provider.id,
    text: finalText.trim() || "(no output)",
    stdout: failed ? "" : finalText.trim(),
    stderr: failed ? finalText.trim() : "",
    exitCode: failed ? 1 : 0,
    timedOut: false,
    usage
  };
}

function buildCodexHeaders(token: string, credential: CodexOAuthCredentials, extra: Record<string, string> | undefined, session: ProviderRunInput["session"]): Headers {
  const headers = new Headers(extra);
  const sessionId = session?.sessionId ?? createRequestId();
  headers.set("authorization", `Bearer ${token}`);
  headers.set("chatgpt-account-id", credential.accountId);
  headers.set("originator", "codex_cli_rs");
  headers.set("user-agent", `codex_cli_rs/0.144.0 (CrewCoder/${CREWCODER_VERSION})`);
  headers.delete("openai-beta");
  headers.set("accept", "text/event-stream");
  headers.set("content-type", "application/json");
  headers.set("session-id", sessionId);
  headers.set("thread-id", sessionId);
  headers.set("x-client-request-id", sessionId);
  headers.set("x-codex-window-id", sessionId);
  return headers;
}

type CodexRequestBody = { [key: string]: unknown; model: string; instructions: string; input: unknown[]; tools?: unknown[]; tool_choice: "auto"; store: false; stream: true; parallel_tool_calls: true; text: { verbosity: "low" }; include: string[]; prompt_cache_key: string; client_metadata: Record<string, string>; reasoning?: { effort: string; summary: "auto" } };

function buildCodexBody(model: string, input: ProviderRunInput): CodexRequestBody {
  const modelInput = input.modelInput;
  const reasoningEffort = codexReasoningEffort(input.reasoningEffort);
  const sessionId = input.session?.sessionId ?? createRequestId();
  const body: CodexRequestBody = {
    model,
    instructions: modelInput?.systemPrompt ?? "You are CrewCoder, a local coding agent CLI.",
    input: modelInput ? convertMessages(modelInput.messages) : [{ role: "user", content: input.prompt }],
    tool_choice: "auto",
    store: false,
    stream: true,
    parallel_tool_calls: true,
    text: { verbosity: "low" },
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: sessionId,
    client_metadata: {
      "session-id": sessionId,
      "thread-id": sessionId,
      "x-codex-window-id": sessionId
    },
    ...(reasoningEffort ? { reasoning: { effort: reasoningEffort, summary: "auto" } } : {})
  };

  if (modelInput?.availableTools.length) {
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

function convertMessages(messages: AgentMessage[]): unknown[] {
  const items: unknown[] = [];
  // A `function_call_output` whose `function_call` is not in this request is a
  // protocol error: the turn comes back empty instead of failing loudly. Compaction,
  // branching, and checkpoint restores can all truncate a transcript mid tool group,
  // so degrade an orphan to plain historical context (same guard as
  // openai-responses-provider and http-provider) rather than sending it.
  const pendingToolCallIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "user") {
      const imageParts = message.content.flatMap((part) => part.type === "image" ? [codexImageBlock(part)] : []).filter((block): block is Record<string, unknown> => block !== undefined);
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
    }
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
      items.push({ type: "function_call_output", call_id: message.toolCallId, output });
    }
  }
  return items;
}

// Responses API image input: { type: "input_image", image_url: "data:<mime>;base64,<data>" }.
function codexImageBlock(part: ImagePart): Record<string, unknown> | undefined {
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

async function fetchCodexWithRetries(endpoint: string, init: RequestInit, input: ProviderRunInput): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_CODEX_RETRY_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(endpoint, init);
      if (!shouldRetryCodexResponse(response.status) || attempt === MAX_CODEX_RETRY_ATTEMPTS) return response;
      try { await response.body?.cancel(); } catch {}

      const delayMs = codexRetryDelayMs(attempt, response.headers.get("retry-after"));
      await input.debug?.event({
        level: "warn",
        source: "provider.codex",
        message: "retrying provider request",
        details: { providerId: input.provider.id, status: response.status, attempt, nextAttempt: attempt + 1, delayMs }
      });
      await sleep(delayMs, init.signal instanceof AbortSignal ? init.signal : undefined);
    } catch (error) {
      if (init.signal instanceof AbortSignal && init.signal.aborted) throw error;
      lastError = error;
      if (attempt === MAX_CODEX_RETRY_ATTEMPTS) break;
      const delayMs = codexRetryDelayMs(attempt);
      await input.debug?.event({
        level: "warn",
        source: "provider.codex",
        message: "retrying provider request after network error",
        details: { providerId: input.provider.id, attempt, nextAttempt: attempt + 1, delayMs, error: describeTransportError(error) }
      });
      await sleep(delayMs, init.signal instanceof AbortSignal ? init.signal : undefined);
    }
  }

  const requestBytes = typeof init.body === "string" ? Buffer.byteLength(init.body) : undefined;
  const sizeHint = requestBytes !== undefined && requestBytes >= CODEX_LARGE_REQUEST_BYTES
    ? ` Request payload was ${Math.ceil(requestBytes / 1024)} KiB; run /compact if transport failures continue.`
    : "";
  throw new Error(`Codex request failed after ${MAX_CODEX_RETRY_ATTEMPTS} attempts: ${describeTransportError(lastError)}.${sizeHint}`, { cause: lastError });
}

function describeTransportError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const details = [error.message];
  let cause: unknown = error.cause;
  const seen = new Set<unknown>([error]);
  while (cause instanceof Error && !seen.has(cause) && details.length < 4) {
    seen.add(cause);
    const code = "code" in cause && typeof cause.code === "string" ? cause.code : undefined;
    const detail = `${code ? `${code}: ` : ""}${cause.message}`;
    if (!details.includes(detail)) details.push(detail);
    cause = cause.cause;
  }
  return details.join("; caused by ");
}

function shouldRetryCodexResponse(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function codexRetryDelayMs(attempt: number, retryAfter?: string | null): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 10_000);
  }
  const jitter = Math.floor(Math.random() * 150);
  return Math.min(CODEX_RETRY_BASE_MS * 2 ** (attempt - 1) + jitter, 5_000);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Request was aborted"));
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timeout);
      reject(new Error("Request was aborted"));
    }, { once: true });
  });
}

async function readCodexStream(response: Response, signal: AbortSignal | undefined, stream: ProviderRunInput["stream"] | undefined, providerId: string, model: string | undefined): Promise<{ text: string; usage?: ModelUsage; error?: string; responseId?: string; assistant?: AssistantMessage }> {
  if (!response.body) return { text: "" };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  const toolCalls = new Map<string, { id: string; name: string; arguments: string }>();
  let completedResponse: unknown;
  let streamError: string | undefined;
  let activeReasoningSummaryText = "";
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
      const payload = isRecord(event.response) ? event.response : event;
      streamError = providerErrorMessage(JSON.stringify(payload));
      return;
    }

    if (type === "response.output_text.delta" && typeof event.delta === "string") {
      text += event.delta;
      await stream?.onAssistantDelta?.(event.delta);
      return;
    }

    if (type === "response.output_text.done" && typeof event.text === "string" && !text.trim()) {
      text = event.text;
      return;
    }

    if (type === "response.output_item.added" && isRecord(event.item) && event.item.type === "reasoning") {
      activeReasoningSummaryText = "";
      return;
    }

    if (type === "response.reasoning_summary_part.added") {
      activeReasoningSummaryText = "";
      return;
    }

    if (isThinkingDeltaEvent(type) && typeof event.delta === "string") {
      activeReasoningSummaryText += event.delta;
      await emitThinking(event.delta);
      return;
    }

    if (isThinkingDeltaEvent(type) && isRecord(event.delta)) {
      const deltaText = collectReasoningTextToString(event.delta);
      if (deltaText) {
        activeReasoningSummaryText += deltaText;
        await emitThinking(deltaText);
      }
      return;
    }

    if (isThinkingDoneEvent(type) && typeof event.text === "string") {
      if (!activeReasoningSummaryText.trim()) await emitReasoningSummary(event.text);
      activeReasoningSummaryText = "";
      return;
    }

    if (type === "response.reasoning_summary_part.done") {
      const part = isRecord(event.part) ? event.part : undefined;
      const partText = part ? collectReasoningTextToString(part) : "";
      if (partText && !activeReasoningSummaryText.trim()) await emitThinking(partText);
      if ((partText || activeReasoningSummaryText).trim()) await emitThinking("\n\n");
      activeReasoningSummaryText = "";
      return;
    }

    if ((type === "response.function_call_arguments.delta" || type === "response.tool_call_arguments.delta") && typeof event.delta === "string") {
      const id = String(event.item_id ?? event.call_id ?? event.output_index ?? "tool");
      const existing = toolCalls.get(id) ?? { id, name: String(event.name ?? ""), arguments: "" };
      existing.arguments += event.delta;
      toolCalls.set(id, existing);
      return;
    }

    if (type === "response.output_item.done" && isRecord(event.item)) {
      const item = event.item;
      if (item.type === "reasoning") {
        const summary = extractReasoningSummaryText({ output: [item] });
        if (summary) await emitReasoningSummary(summary);
        activeReasoningSummaryText = "";
        return;
      }
      if (item.type === "function_call" && typeof item.name === "string") {
        const id = String(item.call_id ?? item.id ?? `tool_${Date.now()}`);
        toolCalls.set(id, { id, name: item.name, arguments: typeof item.arguments === "string" ? item.arguments : "{}" });
      } else if (item.type === "message" && Array.isArray(item.content) && !text.trim()) {
        text = textFromResponseContent(item.content);
      }
      return;
    }

    if ((type === "response.completed" || type === "response.done") && isRecord(event.response)) {
      completedResponse = event.response;
    }
  };

  const processChunk = async (chunk: string) => {
    for (const data of sseDataLines(chunk)) {
      if (data === "[DONE]") continue;
      try { await processEvent(JSON.parse(data) as Record<string, unknown>); } catch {}
    }
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
        await processChunk(chunk);
        boundary = buffer.indexOf("\n\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) await processChunk(buffer);
  } finally {
    try { reader.releaseLock(); } catch {}
  }

  if (completedResponse) {
    const finalThinking = extractReasoningSummaryText(completedResponse);
    if (finalThinking) await emitReasoningSummary(finalThinking);
    const completedContent = assistantContentFromResponse(completedResponse);
    if (!text.trim()) text = completedContent.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
    for (const part of completedContent) {
      if (part.type === "toolCall" && !toolCalls.has(part.id)) toolCalls.set(part.id, { id: part.id, name: part.name, arguments: JSON.stringify(part.arguments) });
    }
  }

  const usage = extractUsageFromResponse(completedResponse, providerId, model);
  if (streamError) return { text: streamError, usage, error: streamError };
  if (!text.trim() && toolCalls.size === 0) {
    const error = "Codex stream ended without assistant text, tool calls, or completion metadata.";
    return { text: error, usage, error };
  }

  const assistant: AssistantMessage = {
    role: "assistant",
    content: [
      ...(text.trim() ? [{ type: "text" as const, text: text.trim() }] : []),
      ...Array.from(toolCalls.values()).filter((call) => call.name).map((call) => ({
        type: "toolCall" as const,
        id: call.id,
        name: call.name,
        arguments: parseJsonObject(call.arguments || "{}")
      }))
    ],
    stopReason: toolCalls.size > 0 ? "tool_calls" : "end",
    timestamp: Date.now()
  };

  const responseId = isRecord(completedResponse) && typeof completedResponse.id === "string" ? completedResponse.id : undefined;
  return { text: JSON.stringify(assistant), usage, responseId, assistant };
}

function extractCodexUsage(raw: string, providerId: string, model?: string): ModelUsage | undefined {
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

function sseDataLines(chunk: string): string[] {
  return chunk.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).filter(Boolean);
}

function codexResponseToCrewCoderAssistantJson(raw: string): string {
  return JSON.stringify(responseToAssistant(raw));
}

function normalizeCodexSuccess(raw: string): string {
  return /(^|\n)\s*data:\s*/.test(raw) ? codexSseToAssistantJson(raw) : raw;
}

function codexSseToAssistantJson(raw: string): string {
  const textParts: string[] = [];
  const toolCalls = new Map<string, { id: string; name: string; arguments: string }>();
  let completedResponse: unknown;
  for (const data of sseDataLines(raw)) {
    if (data === "[DONE]") continue;
    try {
      const event = JSON.parse(data) as Record<string, unknown>;
      const type = String(event.type ?? "");
      if (type === "response.output_text.delta" && typeof event.delta === "string") textParts.push(event.delta);
      else if (type === "response.output_text.done" && typeof event.text === "string" && !textParts.join("").trim()) textParts.push(event.text);
      else if ((type === "response.function_call_arguments.delta" || type === "response.tool_call_arguments.delta") && typeof event.delta === "string") {
        const id = String(event.item_id ?? event.call_id ?? event.output_index ?? "tool");
        const existing = toolCalls.get(id) ?? { id, name: String(event.name ?? ""), arguments: "" };
        existing.arguments += event.delta;
        toolCalls.set(id, existing);
      } else if (type === "response.output_item.done" && isRecord(event.item) && event.item.type === "function_call" && typeof event.item.name === "string") {
        const id = String(event.item.call_id ?? event.item.id ?? `tool_${Date.now()}`);
        toolCalls.set(id, { id, name: event.item.name, arguments: typeof event.item.arguments === "string" ? event.item.arguments : toolCalls.get(id)?.arguments ?? "{}" });
      } else if ((type === "response.completed" || type === "response.done") && isRecord(event.response)) {
        completedResponse = event.response;
      }
    } catch {}
  }
  if (!textParts.join("").trim() && toolCalls.size === 0 && completedResponse) return codexResponseToCrewCoderAssistantJson(JSON.stringify(completedResponse));
  const assistant: AssistantMessage = {
    role: "assistant",
    content: [
      ...(textParts.join("").trim() ? [{ type: "text" as const, text: textParts.join("").trim() }] : []),
      ...Array.from(toolCalls.values()).filter((call) => call.name).map((call) => ({ type: "toolCall" as const, id: call.id, name: call.name, arguments: parseJsonObject(call.arguments || "{}") }))
    ],
    stopReason: toolCalls.size > 0 ? "tool_calls" : "end",
    timestamp: Date.now()
  };
  if (assistant.content.length === 0) assistant.content.push({ type: "text", text: raw });
  return JSON.stringify(assistant);
}

function responseToAssistant(raw: string): AssistantMessage {
  try {
    const content = assistantContentFromResponse(JSON.parse(raw) as unknown);
    return { role: "assistant", content: content.length ? content : [{ type: "text", text: raw }], stopReason: content.some((part) => part.type === "toolCall") ? "tool_calls" : "end", timestamp: Date.now() };
  } catch {
    return { role: "assistant", content: [{ type: "text", text: raw }], stopReason: "end", timestamp: Date.now() };
  }
}

function assistantContentFromResponse(response: unknown): AssistantMessage["content"] {
  if (!isRecord(response)) return [];
  const content: AssistantMessage["content"] = [];
  if (typeof response.output_text === "string" && response.output_text.trim()) content.push({ type: "text", text: response.output_text });
  if (!Array.isArray(response.output)) return content;
  for (const item of response.output) {
    if (!isRecord(item)) continue;
    if (item.type === "message" && Array.isArray(item.content)) {
      const text = textFromResponseContent(item.content);
      if (text) content.push({ type: "text", text });
    }
    if (item.type === "function_call" && typeof item.name === "string") {
      content.push({ type: "toolCall", id: String(item.call_id ?? item.id ?? createRequestId()), name: item.name, arguments: parseJsonObject(String(item.arguments ?? "{}")) } satisfies ToolCallPart);
    }
  }
  return content;
}

function textFromResponseContent(content: unknown[]): string {
  return content.flatMap((part) => isRecord(part) && (part.type === "output_text" || part.type === "text") && typeof part.text === "string" ? [part.text] : []).join("\n").trim();
}

function normalizeCodexError(raw: string, status: number, statusText: string): string {
  const fallback = raw.trim() || statusText || "request failed";
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isRecord(parsed)) {
      const error = isRecord(parsed.error) ? parsed.error : parsed;
      const message = stringField(error, "message") ?? stringField(error, "detail") ?? stringField(error, "title") ?? fallback;
      const code = stringField(error, "code") ?? stringField(error, "type");
      return `Codex API error (${status}${code ? `, ${code}` : ""}): ${message}`;
    }
  } catch {}
  return `Codex API error (${status}): ${fallback}`;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
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

function codexReasoningEffort(requested?: string): string | undefined {
  const value = (requested ?? process.env.CREWCODER_THINKING ?? process.env.CREWCODER_REASONING_EFFORT ?? "low").trim().toLowerCase();
  if (!value || value === "false" || value === "0") return undefined;
  if (value === "off") return "none";
  if (value === "minimal") return "low";
  if (["none", "low", "medium", "high", "xhigh"].includes(value)) return value;
  return value;
}

function parseJsonObject(text: string): Record<string, unknown> {
  try { const parsed = JSON.parse(text) as unknown; return isRecord(parsed) ? parsed : {}; } catch { return {}; }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function createRequestId(): string {
  return typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `codex_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}
