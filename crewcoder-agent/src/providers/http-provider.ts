import fs from "node:fs";
import type { AgentMessage, AssistantMessage, ImagePart, ToolCallPart } from "../core/messages.js";
import type { ModelInput } from "../core/model-client.js";
import { supportsParallelToolCalls } from "./model-resolution.js";
import { toolParameters } from "../core/tool-schema.js";
import { normalizeUsage } from "../core/usage.js";
import { getProviderApiKey } from "./auth-store.js";
import { providerErrorMessage } from "./output-parser.js";
import type { ProviderRunInput, ProviderRunResult } from "./types.js";

export async function runHttpMessagesProvider(input: ProviderRunInput, signal?: AbortSignal): Promise<ProviderRunResult> {
  const startedAt = Date.now();
  const apiKey = await getProviderApiKey(input.provider);
  if (!apiKey) throw new Error(`Provider ${input.provider.id} requires ${input.provider.apiKeyEnv ?? `${input.provider.id} auth`}`);

  const model = input.model?.trim();
  if (!model || model === "default") throw new Error(`Provider ${input.provider.id} requires a concrete model`);

  const endpoint = resolveProviderEndpoint(input.provider, model);
  if (!endpoint) throw new Error(`Provider ${input.provider.id} is missing endpoint`);

  const body = buildProviderHttpBody(model, input);

  await input.debug?.event({
    level: "info",
    source: "provider.http",
    message: "starting provider request",
    details: { providerId: input.provider.id, endpoint, model, messages: body.messages.length, tools: body.tools?.length ?? 0, promptFallback: body.promptFallback }
  });

  const response = await fetch(endpoint, {
    method: "POST",
    signal,
    headers: providerHeaders(input, apiKey, model),
    body: JSON.stringify(stripInternalBodyFields(body))
  });

  const streamed = response.ok && (response.headers.get("content-type") ?? "").includes("text/event-stream")
    ? await readHttpMessagesStream(response, signal, input.stream, input.provider.id, model)
    : undefined;
  const raw = streamed?.text ?? await response.text();
  const failed = !response.ok || Boolean(streamed?.error);
  const text = failed ? streamed?.error ?? raw : streamed?.text ?? normalizeCrewCoderAssistantJson(raw) ?? anthropicResponseToCrewCoderAssistantJson(raw);
  const usage = response.ok ? streamed?.usage ?? extractAnthropicUsage(raw, input.provider.id, model) : undefined;

  await input.debug?.event({
    level: failed ? "error" : "info",
    source: "provider.http",
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

type AnthropicMessagesBody = {
  model: string;
  max_tokens: number;
  messages: Array<Record<string, unknown>>;
  system?: string;
  tools?: Array<Record<string, unknown>>;
  stream: true;
  thinking?: { type: "enabled"; budget_tokens: number };
  promptFallback?: boolean;
};

type OpenAiChatBody = {
  model: string;
  max_tokens: number;
  messages: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
  parallel_tool_calls?: true;
  stream: true;
  promptFallback?: boolean;
};

type ProviderHttpBody = AnthropicMessagesBody | OpenAiChatBody;

function buildProviderHttpBody(model: string, input: ProviderRunInput): ProviderHttpBody {
  const thinking = anthropicThinking(input.reasoningEffort);
  const modelInput = input.modelInput;
  if (!modelInput) {
    const content = input.prompt.trim();
    if (!content) throw new Error(`Provider ${input.provider.id} requires a non-empty prompt`);
    if (usesOpenAiChatBody(input, model)) return buildOpenAiChatBody(model, input, [{ role: "user", content }], undefined);
    return {
      model,
      max_tokens: thinking ? thinking.budget_tokens + 4096 : 4096,
      messages: [{ role: "user", content }],
      stream: true,
      ...(thinking ? { thinking } : {})
    };
  }

  if (usesOpenAiChatBody(input, model)) return buildOpenAiChatBody(model, input, convertMessagesForOpenAiChat(modelInput.messages, modelInput.systemPrompt), modelInput);

  const convertedMessages = convertMessages(modelInput.messages);
  const promptFallback = convertedMessages.length === 0 ? input.prompt.trim() : "";
  if (convertedMessages.length === 0 && !promptFallback) throw new Error(`Provider ${input.provider.id} requires at least one non-empty message`);

  const body: AnthropicMessagesBody = {
    model,
    max_tokens: thinking ? thinking.budget_tokens + 4096 : 4096,
    system: modelInput.systemPrompt,
    messages: convertedMessages.length > 0 ? convertedMessages : [{ role: "user", content: promptFallback }],
    stream: true,
    ...(promptFallback ? { promptFallback: true } : {}),
    ...(thinking ? { thinking } : {})
  };

  if (modelInput.availableTools.length > 0) {
    body.tools = modelInput.availableTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: toolParameters(tool)
    }));
  }

  return body;
}

function buildOpenAiChatBody(model: string, input: ProviderRunInput, convertedMessages: Array<Record<string, unknown>>, modelInput?: ModelInput): OpenAiChatBody {
  const hasConversationMessage = convertedMessages.some((message) => message.role !== "system");
  const promptFallback = hasConversationMessage ? "" : input.prompt.trim();
  if (!hasConversationMessage && !promptFallback) throw new Error(`Provider ${input.provider.id} requires at least one non-empty message`);
  const body: OpenAiChatBody = {
    model,
    max_tokens: 4096,
    messages: promptFallback ? [...convertedMessages, { role: "user", content: promptFallback }] : convertedMessages,
    stream: true,
    ...(promptFallback ? { promptFallback: true } : {})
  };

  if (modelInput?.availableTools.length) {
    body.tools = modelInput.availableTools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: toolParameters(tool)
      }
    }));
    if (supportsParallelToolCalls(input.provider, model)) body.parallel_tool_calls = true;
  }

  return body;
}

function stripInternalBodyFields(body: ProviderHttpBody): Omit<ProviderHttpBody, "promptFallback"> {
  const { promptFallback: _promptFallback, ...requestBody } = body;
  return requestBody;
}

async function readHttpMessagesStream(response: Response, signal: AbortSignal | undefined, stream: ProviderRunInput["stream"] | undefined, providerId: string, model: string): Promise<{ text: string; usage?: ReturnType<typeof normalizeUsage>; error?: string }> {
  if (!response.body) return { text: "" };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const content: AssistantMessage["content"] = [];
  const textParts = new Map<number, string>();
  const toolCalls = new Map<number, { id: string; name: string; inputJson: string; input?: Record<string, unknown> }>();
  let usage: ReturnType<typeof normalizeUsage>;
  let stopReason: AssistantMessage["stopReason"] = "end";
  let streamError: string | undefined;
  let buffer = "";

  const processEvent = async (event: Record<string, unknown>) => {
    const type = String(event.type ?? "");
    // Anthropic-compatible endpoints can return HTTP 200 and then emit an error
    // event mid-stream (overloaded_error, rate limits). Without this the run
    // ends as an empty-but-successful response.
    if (type === "error") {
      streamError = providerErrorMessage(JSON.stringify(event));
      return;
    }
    if (type === "message_start" && isRecord(event.message)) {
      usage = normalizeUsage(event.message.usage, providerId, model) ?? usage;
      return;
    }
    if (type === "message_delta") {
      if (isRecord(event.delta) && event.delta.stop_reason === "tool_use") stopReason = "tool_calls";
      usage = normalizeUsage(event.usage, providerId, model) ?? usage;
      return;
    }
    if (type === "content_block_start" && typeof event.index === "number" && isRecord(event.content_block)) {
      const block = event.content_block;
      if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
        toolCalls.set(event.index, { id: block.id, name: block.name, inputJson: "", input: isRecord(block.input) ? block.input : undefined });
      }
      if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking) await stream?.onThinkingDelta?.(block.thinking);
      return;
    }
    if (type === "content_block_delta" && typeof event.index === "number" && isRecord(event.delta)) {
      const delta = event.delta;
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        textParts.set(event.index, `${textParts.get(event.index) ?? ""}${delta.text}`);
        await stream?.onAssistantDelta?.(delta.text);
      } else if ((delta.type === "thinking_delta" || delta.type === "reasoning_delta") && typeof delta.thinking === "string") {
        await stream?.onThinkingDelta?.(delta.thinking);
      } else if ((delta.type === "thinking_delta" || delta.type === "reasoning_delta") && typeof delta.text === "string") {
        await stream?.onThinkingDelta?.(delta.text);
      } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
        const call = toolCalls.get(event.index) ?? { id: `tool_${event.index}`, name: "", inputJson: "" };
        call.inputJson += delta.partial_json;
        toolCalls.set(event.index, call);
      }
      return;
    }
    if (type === "content_block_stop" && typeof event.index === "number") {
      const text = textParts.get(event.index);
      if (text?.trim()) content.push({ type: "text", text: text.trim() });
      const call = toolCalls.get(event.index);
      if (call?.name) content.push({ type: "toolCall", id: call.id, name: call.name, arguments: call.inputJson ? parseJsonObject(call.inputJson) : call.input ?? {} });
      return;
    }
    if (type === "message_stop") return;
    if (isRecord(event.error)) {
      streamError = providerErrorMessage(JSON.stringify(event));
      return;
    }
    if (Array.isArray(event.choices)) {
      usage = normalizeUsage(event.usage, providerId, model) ?? usage;
      for (const choice of event.choices) {
        if (!isRecord(choice)) continue;
        if (choice.finish_reason === "tool_calls") stopReason = "tool_calls";
        if (!isRecord(choice.delta)) continue;
        const delta = choice.delta;
        if (typeof delta.content === "string") {
          textParts.set(0, `${textParts.get(0) ?? ""}${delta.content}`);
          await stream?.onAssistantDelta?.(delta.content);
        }
        const reasoning = typeof delta.reasoning_content === "string"
          ? delta.reasoning_content
          : typeof delta.reasoning === "string"
            ? delta.reasoning
            : undefined;
        if (reasoning) await stream?.onThinkingDelta?.(reasoning);
        if (Array.isArray(delta.tool_calls)) {
          for (const toolCall of delta.tool_calls) appendOpenAiToolCallDelta(toolCalls, toolCall);
        }
      }
      return;
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
        for (const data of sseDataLines(chunk)) {
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

  appendPendingStreamContent(content, textParts, toolCalls);

  if (streamError) return { text: streamError, usage, error: streamError };

  const assistant: AssistantMessage = {
    role: "assistant",
    content: content.length ? content : [{ type: "text", text: "(empty provider response)" }],
    stopReason,
    timestamp: Date.now()
  };
  return { text: normalizeTextAssistantJson(assistant) ?? JSON.stringify(assistant), usage };
}

function appendPendingStreamContent(
  content: AssistantMessage["content"],
  textParts: Map<number, string>,
  toolCalls: Map<number, { id: string; name: string; inputJson: string; input?: Record<string, unknown> }>
): void {
  if (!content.some((part) => part.type === "text")) {
    const text = Array.from(textParts.entries())
      .sort(([a], [b]) => a - b)
      .map(([, value]) => value)
      .join("")
      .trim();
    if (text) content.push({ type: "text", text });
  }

  const existingToolIds = new Set(content.flatMap((part) => part.type === "toolCall" ? [part.id] : []));
  for (const call of toolCalls.values()) {
    if (!call.name || existingToolIds.has(call.id)) continue;
    content.push({ type: "toolCall", id: call.id, name: call.name, arguments: call.inputJson ? parseJsonObject(call.inputJson) : call.input ?? {} });
  }
}

function readImageBase64(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath).toString("base64");
  } catch {
    return undefined;
  }
}

// Anthropic messages image block: { type: "image", source: { type: "base64", ... } }.
function anthropicImageBlock(part: ImagePart): Record<string, unknown> | undefined {
  const data = readImageBase64(part.path);
  if (!data) return undefined;
  return { type: "image", source: { type: "base64", media_type: part.mime, data } };
}

// OpenAI chat image block: { type: "image_url", image_url: { url: dataUri } }.
function openAiImageBlock(part: ImagePart): Record<string, unknown> | undefined {
  const data = readImageBase64(part.path);
  if (!data) return undefined;
  return { type: "image_url", image_url: { url: `data:${part.mime};base64,${data}` } };
}

function convertMessages(messages: AgentMessage[]): Array<Record<string, unknown>> {
  const converted: Array<Record<string, unknown>> = [];
  const pendingToolUseIds = new Set<string>();

  for (const message of messages) {
    if (message.role === "user") {
      const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      const imageBlocks = message.content.flatMap((part) => part.type === "image" ? [anthropicImageBlock(part)] : []).filter((block): block is Record<string, unknown> => block !== undefined);
      if (imageBlocks.length) {
        // Anthropic requires an array content when any block is non-text.
        const content: Array<Record<string, unknown>> = [];
        if (text.trim()) content.push({ type: "text", text });
        content.push(...imageBlocks);
        converted.push({ role: "user", content });
      } else {
        converted.push({ role: "user", content: text });
      }
      continue;
    }

    if (message.role === "assistant") {
      const content = message.content.flatMap((part): Array<Record<string, unknown>> => {
        if (part.type === "text") return [{ type: "text", text: part.text }];
        if (part.type === "toolCall") {
          pendingToolUseIds.add(part.id);
          return [{ type: "tool_use", id: part.id, name: part.name, input: part.arguments }];
        }
        return [];
      });
      converted.push({ role: "assistant", content: content.length ? content : [{ type: "text", text: "" }] });
      continue;
    }

    const toolText = message.content.map((part) => part.text).join("\n");
    if (!pendingToolUseIds.has(message.toolCallId)) {
      converted.push({ role: "user", content: `Historical tool result from ${message.toolName}:\n${toolText}` });
      continue;
    }
    pendingToolUseIds.delete(message.toolCallId);
    converted.push({
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: message.toolCallId,
        content: toolText,
        is_error: message.isError
      }]
    });
  }

  return converted.filter((message) => {
    if (typeof message.content === "string") return message.content.trim().length > 0;
    return true;
  });
}

function convertMessagesForOpenAiChat(messages: AgentMessage[], systemPrompt: string): Array<Record<string, unknown>> {
  const converted: Array<Record<string, unknown>> = [];
  const pendingToolCallIds = new Set<string>();
  if (systemPrompt.trim()) converted.push({ role: "system", content: systemPrompt });

  for (const message of messages) {
    if (message.role === "user") {
      const text = textFromMessage(message).trim();
      const imageParts = message.content.flatMap((part) => part.type === "image" ? [openAiImageBlock(part)] : []).filter((block): block is Record<string, unknown> => block !== undefined);
      if (imageParts.length) {
        // OpenAI chat multimodal content is an array of typed parts.
        const parts: Array<Record<string, unknown>> = [];
        if (text) parts.push({ type: "text", text });
        parts.push(...imageParts);
        converted.push({ role: "user", content: parts });
      } else if (text) {
        converted.push({ role: "user", content: text });
      }
      continue;
    }

    if (message.role === "assistant") {
      const text = textFromMessage(message).trim();
      const toolCalls = message.content.flatMap((part) => part.type === "toolCall" ? [{
        id: part.id,
        type: "function",
        function: { name: part.name, arguments: JSON.stringify(part.arguments) }
      }] : []);
      if (text || toolCalls.length) {
        for (const toolCall of toolCalls) pendingToolCallIds.add(toolCall.id);
        converted.push({
          role: "assistant",
          content: text || null,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {})
        });
      }
      continue;
    }

    const toolText = textFromMessage(message);
    if (!pendingToolCallIds.has(message.toolCallId)) {
      converted.push({ role: "user", content: `Historical tool result from ${message.toolName}:\n${toolText}` });
      continue;
    }
    pendingToolCallIds.delete(message.toolCallId);
    converted.push({
      role: "tool",
      tool_call_id: message.toolCallId,
      content: toolText
    });
  }

  return converted;
}

function textFromMessage(message: AgentMessage): string {
  return message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
}

function anthropicResponseToCrewCoderAssistantJson(raw: string): string {
  const normalized = normalizeCrewCoderAssistantJson(raw);
  if (normalized) return normalized;
  const assistant = anthropicResponseToAssistant(raw);
  return JSON.stringify(assistant);
}

function normalizeTextAssistantJson(assistant: AssistantMessage): string | undefined {
  if (assistant.content.length !== 1) return undefined;
  const [part] = assistant.content;
  if (part.type !== "text") return undefined;
  return normalizeCrewCoderAssistantJson(part.text);
}

function normalizeCrewCoderAssistantJson(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || parsed.role !== "assistant" || !Array.isArray(parsed.content)) return undefined;
    const content = parsed.content.flatMap((part): AssistantMessage["content"] => {
      if (!isRecord(part)) return [];
      if (part.type === "text" && typeof part.text === "string") return [{ type: "text", text: part.text }];
      if (part.type === "toolCall" && typeof part.id === "string" && typeof part.name === "string") {
        return [{
          type: "toolCall",
          id: part.id,
          name: part.name,
          arguments: isRecord(part.arguments) ? part.arguments : {}
        }];
      }
      return [];
    });
    if (!content.length) return undefined;
    const hasToolCall = content.some((part) => part.type === "toolCall");
    const stopReason = hasToolCall
      ? "tool_calls"
      : parsed.stopReason === "error" || parsed.stopReason === "aborted" || parsed.stopReason === "end"
        ? parsed.stopReason
        : "end";
    return JSON.stringify({
      role: "assistant",
      content,
      stopReason,
      timestamp: typeof parsed.timestamp === "number" ? parsed.timestamp : Date.now()
    } satisfies AssistantMessage);
  } catch {
    return undefined;
  }
}

function extractAnthropicUsage(raw: string, providerId: string, model: string) {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return undefined;
    return normalizeUsage(parsed.usage, providerId, typeof parsed.model === "string" ? parsed.model : model);
  } catch {
    return undefined;
  }
}

function anthropicResponseToAssistant(raw: string): AssistantMessage {
  try {
    const parsed = JSON.parse(raw) as { content?: Array<Record<string, unknown>>; stop_reason?: string; choices?: Array<Record<string, unknown>> };
    const openAiAssistant = openAiChatResponseToAssistant(parsed);
    if (openAiAssistant) return openAiAssistant;
    const content = parsed.content?.flatMap((part): Array<AssistantMessage["content"][number]> => {
      if (part.type === "text" && typeof part.text === "string") return [{ type: "text", text: part.text }];
      if (part.type === "tool_use" && typeof part.id === "string" && typeof part.name === "string") {
        return [{
          type: "toolCall",
          id: part.id,
          name: part.name,
          arguments: isRecord(part.input) ? part.input : {}
        } satisfies ToolCallPart];
      }
      return [];
    }) ?? [];

    return {
      role: "assistant",
      content: content.length ? content : [{ type: "text", text: raw }],
      stopReason: content.some((part) => part.type === "toolCall") || parsed.stop_reason === "tool_use" ? "tool_calls" : "end",
      timestamp: Date.now()
    };
  } catch {
    return { role: "assistant", content: [{ type: "text", text: raw }], stopReason: "end", timestamp: Date.now() };
  }
}

function openAiChatResponseToAssistant(parsed: { choices?: Array<Record<string, unknown>> }): AssistantMessage | undefined {
  const choice = parsed.choices?.find((item) => isRecord(item.message));
  const message = isRecord(choice?.message) ? choice.message : undefined;
  if (!message) return undefined;
  const content: AssistantMessage["content"] = [];
  if (typeof message.content === "string" && message.content.trim()) content.push({ type: "text", text: message.content.trim() });
  if (Array.isArray(message.tool_calls)) {
    for (const toolCall of message.tool_calls) {
      if (!isRecord(toolCall) || !isRecord(toolCall.function) || typeof toolCall.function.name !== "string") continue;
      content.push({
        type: "toolCall",
        id: typeof toolCall.id === "string" ? toolCall.id : `call_${content.length}`,
        name: toolCall.function.name,
        arguments: typeof toolCall.function.arguments === "string" ? parseJsonObject(toolCall.function.arguments) : {}
      });
    }
  }
  if (!content.length) return undefined;
  return {
    role: "assistant",
    content,
    stopReason: content.some((part) => part.type === "toolCall") ? "tool_calls" : "end",
    timestamp: Date.now()
  };
}

function anthropicThinking(requested?: string): { type: "enabled"; budget_tokens: number } | undefined {
  const value = (requested ?? process.env.CREWCODER_THINKING ?? process.env.CREWCODER_REASONING_EFFORT ?? "").trim().toLowerCase();
  if (!value || value === "none" || value === "off" || value === "false" || value === "0") return undefined;
  const budget = value === "high" ? 4096 : value === "xhigh" ? 8192 : 2048;
  return { type: "enabled", budget_tokens: budget };
}

function resolveProviderEndpoint(provider: ProviderRunInput["provider"], model: string): string | undefined {
  if (!provider.endpoint) return undefined;
  if (provider.runtime === "openai-chat-completions" || !usesOpenAiChatModel(model)) return provider.endpoint;
  return provider.endpoint.replace(/\/messages\/?$/, "/chat/completions");
}

function providerHeaders(input: ProviderRunInput, apiKey: string, model: string): Record<string, string> {
  const scheme = input.provider.authScheme ?? (input.provider.runtime === "openai-chat-completions" ? "bearer" : "bearer-and-anthropic-key");
  return {
    "content-type": "application/json",
    ...(usesOpenAiChatBody(input, model) ? {} : { "anthropic-version": "2023-06-01" }),
    ...(scheme === "bearer" || scheme === "bearer-and-anthropic-key" ? { authorization: `Bearer ${apiKey}` } : {}),
    ...(scheme === "anthropic-key" || scheme === "bearer-and-anthropic-key" ? { "x-api-key": apiKey } : {}),
    ...(input.provider.headers ?? {})
  };
}

function usesOpenAiChatBody(input: ProviderRunInput, model: string): boolean {
  return input.provider.runtime === "openai-chat-completions" || usesOpenAiChatModel(model);
}

function usesOpenAiChatModel(model: string): boolean {
  return /deepseek|kimi|glm|mimo/i.test(model);
}

function sseDataLines(chunk: string): string[] {
  return chunk.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).filter(Boolean);
}

function parseJsonObject(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function appendOpenAiToolCallDelta(toolCalls: Map<number, { id: string; name: string; inputJson: string; input?: Record<string, unknown> }>, value: unknown): void {
  if (!isRecord(value)) return;
  const index = typeof value.index === "number" ? value.index : toolCalls.size;
  const existing = toolCalls.get(index) ?? { id: `tool_${index}`, name: "", inputJson: "" };
  if (typeof value.id === "string") existing.id = value.id;
  if (isRecord(value.function)) {
    if (typeof value.function.name === "string") existing.name = value.function.name;
    if (typeof value.function.arguments === "string") existing.inputJson += value.function.arguments;
  }
  toolCalls.set(index, existing);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
