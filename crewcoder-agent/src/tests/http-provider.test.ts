import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runHttpMessagesProvider as runAnthropicMessagesProvider } from "../providers/http-provider.js";
import type { ProviderDefinition } from "../providers/types.js";

function writeTempPng(): { filePath: string; base64: string } {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
  const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-vision-")), "shot.png");
  fs.writeFileSync(filePath, bytes);
  return { filePath, base64: bytes.toString("base64") };
}

const provider: ProviderDefinition = {
  id: "opencode-test",
  title: "OpenCode Test",
  kind: "builtin",
  runtime: "anthropic-messages",
  command: "",
  args: [],
  endpoint: "https://example.test/messages",
  apiKeyEnv: "OPENCODE_TEST_KEY"
};

const goProvider: ProviderDefinition = {
  ...provider,
  id: "opencode-go-test",
  endpoint: "https://opencode.ai/zen/go/v1/messages"
};

describe("anthropic/openCode provider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.OPENCODE_TEST_KEY;
  });

  it("uses x-api-key without bearer auth for the official Anthropic scheme", async () => {
    process.env.OPENCODE_TEST_KEY = "test-key";
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await runAnthropicMessagesProvider({
      provider: { ...provider, id: "anthropic", authScheme: "anthropic-key" },
      prompt: "hello",
      cwd: process.cwd(),
      model: "claude-sonnet-5"
    });

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("test-key");
    expect(headers.authorization).toBeUndefined();
    expect(headers["anthropic-version"]).toBe("2023-06-01");
  });

  it("sends rich tool schemas as Anthropic input_schema", async () => {
    process.env.OPENCODE_TEST_KEY = "test-key";
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 3, output_tokens: 1 } }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await runAnthropicMessagesProvider({
      provider,
      prompt: "read a file",
      cwd: process.cwd(),
      model: "qwen3-coder",
      modelInput: {
        systemPrompt: "system",
        messages: [{ role: "user", content: [{ type: "text", text: "read package" }], timestamp: Date.now() }],
        availableTools: [{
          name: "read",
          description: "Read a workspace file.",
          parameters: {
            type: "object",
            properties: { path: { type: "string", description: "Workspace-relative file path." } },
            required: ["path"],
            additionalProperties: false
          }
        }]
      }
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.tools[0]).toEqual({
      name: "read",
      description: "Read a workspace file.",
      input_schema: {
        type: "object",
        properties: { path: { type: "string", description: "Workspace-relative file path." } },
        required: ["path"],
        additionalProperties: false
      }
    });
  });

  it("adds OpenAI function tool shape for DeepSeek through OpenCode Go", async () => {
    process.env.OPENCODE_TEST_KEY = "test-key";
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await runAnthropicMessagesProvider({
      provider,
      prompt: "read a file",
      cwd: process.cwd(),
      model: "deepseek-v4-flash",
      modelInput: {
        systemPrompt: "system",
        messages: [{ role: "user", content: [{ type: "text", text: "read package" }], timestamp: Date.now() }],
        availableTools: [{
          name: "read",
          description: "Read a workspace file.",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
            additionalProperties: false
          }
        }]
      }
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.tools[0]).toEqual({
      type: "function",
      function: {
        name: "read",
        description: "Read a workspace file.",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false }
      }
    });
    expect(body.system).toBeUndefined();
    expect(body.messages[0]).toEqual({ role: "system", content: "system" });
    expect(body.messages[1]).toEqual({ role: "user", content: "read package" });
  });

  it("encodes an image part as an Anthropic base64 image block", async () => {
    process.env.OPENCODE_TEST_KEY = "test-key";
    const { filePath, base64 } = writeTempPng();
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await runAnthropicMessagesProvider({
      provider,
      prompt: "what is this",
      cwd: process.cwd(),
      model: "qwen3-coder",
      modelInput: {
        systemPrompt: "system",
        messages: [{ role: "user", content: [{ type: "text", text: "what is this" }, { type: "image", mime: "image/png", path: filePath }], timestamp: Date.now() }],
        availableTools: []
      }
    });

    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.messages[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "what is this" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: base64 } }
      ]
    });
  });

  it("encodes an image part as an OpenAI chat image_url data URI", async () => {
    process.env.OPENCODE_TEST_KEY = "test-key";
    const { filePath, base64 } = writeTempPng();
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await runAnthropicMessagesProvider({
      provider: goProvider,
      prompt: "what is this",
      cwd: process.cwd(),
      model: "kimi-k2.7",
      modelInput: {
        systemPrompt: "system",
        messages: [{ role: "user", content: [{ type: "text", text: "what is this" }, { type: "image", mime: "image/png", path: filePath }], timestamp: Date.now() }],
        availableTools: []
      }
    });

    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    const userMessage = body.messages.find((message: { role: string }) => message.role === "user");
    expect(userMessage.content).toEqual([
      { type: "text", text: "what is this" },
      { type: "image_url", image_url: { url: `data:image/png;base64,${base64}` } }
    ]);
  });

  it("uses OpenAI chat function tools for Kimi through OpenCode Go", async () => {
    process.env.OPENCODE_TEST_KEY = "test-key";
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await runAnthropicMessagesProvider({
      provider: goProvider,
      prompt: "list files",
      cwd: process.cwd(),
      model: "kimi-k2.7",
      modelInput: {
        systemPrompt: "system",
        messages: [{ role: "user", content: [{ type: "text", text: "list files" }], timestamp: Date.now() }],
        availableTools: [{
          name: "listFiles",
          description: "List files under a workspace-relative path.",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            additionalProperties: false
          }
        }]
      }
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://opencode.ai/zen/go/v1/chat/completions");
    expect((init.headers as Record<string, string>)["anthropic-version"]).toBeUndefined();
    const body = JSON.parse(String(init.body));
    expect(body.system).toBeUndefined();
    expect(body.messages).toEqual([
      { role: "system", content: "system" },
      { role: "user", content: "list files" }
    ]);
    expect(body.tools).toEqual([{
      type: "function",
      function: {
        name: "listFiles",
        description: "List files under a workspace-relative path.",
        parameters: { type: "object", properties: { path: { type: "string" } }, additionalProperties: false }
      }
    }]);
  });

  it("keeps Anthropic messages endpoint for MiniMax through OpenCode Go", async () => {
    process.env.OPENCODE_TEST_KEY = "test-key";
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await runAnthropicMessagesProvider({
      provider: goProvider,
      prompt: "read a file",
      cwd: process.cwd(),
      model: "minimax-m3",
      modelInput: {
        systemPrompt: "system",
        messages: [{ role: "user", content: [{ type: "text", text: "read package" }], timestamp: Date.now() }],
        availableTools: [{
          name: "read",
          description: "Read a workspace file.",
          parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false }
        }]
      }
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://opencode.ai/zen/go/v1/messages");
    expect((init.headers as Record<string, string>)["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(String(init.body));
    expect(body.tools[0]).toEqual({
      name: "read",
      description: "Read a workspace file.",
      input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false }
    });
  });

  it("converts DeepSeek tool-call continuations to OpenAI chat messages", async () => {
    process.env.OPENCODE_TEST_KEY = "test-key";
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await runAnthropicMessagesProvider({
      provider,
      prompt: "continue",
      cwd: process.cwd(),
      model: "deepseek-v4-flash",
      modelInput: {
        systemPrompt: "system",
        messages: [
          { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "README.md" } }], stopReason: "tool_calls", timestamp: Date.now() },
          { role: "toolResult", toolCallId: "call_1", toolName: "read", content: [{ type: "text", text: "README contents" }], isError: false, timestamp: Date.now() }
        ],
        availableTools: []
      }
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.messages).toEqual([
      { role: "system", content: "system" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{\"path\":\"README.md\"}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "README contents" }
    ]);
  });

  it("converts orphaned DeepSeek tool results to user context instead of invalid tool messages", async () => {
    process.env.OPENCODE_TEST_KEY = "test-key";
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await runAnthropicMessagesProvider({
      provider,
      prompt: "continue",
      cwd: process.cwd(),
      model: "deepseek-v4-flash",
      modelInput: {
        systemPrompt: "system",
        messages: [
          { role: "user", content: [{ type: "text", text: "Background from compacted earlier session" }], timestamp: Date.now() },
          { role: "toolResult", toolCallId: "call_missing", toolName: "read", content: [{ type: "text", text: "README contents" }], isError: false, timestamp: Date.now() },
          { role: "user", content: [{ type: "text", text: "next prompt" }], timestamp: Date.now() }
        ],
        availableTools: []
      }
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.messages).toEqual([
      { role: "system", content: "system" },
      { role: "user", content: "Background from compacted earlier session" },
      { role: "user", content: "Historical tool result from read:\nREADME contents" },
      { role: "user", content: "next prompt" }
    ]);
  });

  it("falls back to the plain prompt when converted model messages are empty", async () => {
    process.env.OPENCODE_TEST_KEY = "test-key";
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await runAnthropicMessagesProvider({
      provider,
      prompt: "resume from the existing conversation",
      cwd: process.cwd(),
      model: "kimi-k2.7",
      modelInput: {
        systemPrompt: "system",
        messages: [{ role: "user", content: [{ type: "text", text: "   " }], timestamp: Date.now() }],
        availableTools: []
      }
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.messages).toEqual([
      { role: "system", content: "system" },
      { role: "user", content: "resume from the existing conversation" }
    ]);
    expect(body.promptFallback).toBeUndefined();
  });

  it("fails locally instead of sending an empty OpenCode request", async () => {
    process.env.OPENCODE_TEST_KEY = "test-key";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(runAnthropicMessagesProvider({
      provider,
      prompt: " ",
      cwd: process.cwd(),
      model: "kimi-k2.7",
      modelInput: {
        systemPrompt: "system",
        messages: [{ role: "user", content: [{ type: "text", text: "   " }], timestamp: Date.now() }],
        availableTools: []
      }
    })).rejects.toThrow("requires at least one non-empty message");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("streams Anthropic/OpenCode thinking and assistant deltas", async () => {
    process.env.OPENCODE_TEST_KEY = "test-key";
    const sse = [
      event({ type: "message_start", message: { usage: { input_tokens: 2, output_tokens: 0 } } }),
      event({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
      event({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "checking" } }),
      event({ type: "content_block_stop", index: 0 }),
      event({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
      event({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "ok" } }),
      event({ type: "content_block_stop", index: 1 }),
      event({ type: "message_delta", usage: { output_tokens: 1 } }),
      event({ type: "message_stop" })
    ].join("");
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(streamFromString(sse), { headers: { "content-type": "text/event-stream" } }));
    vi.stubGlobal("fetch", fetchMock);
    const assistantDeltas: string[] = [];
    const thinkingDeltas: string[] = [];

    const result = await runAnthropicMessagesProvider({
      provider,
      prompt: "hello",
      cwd: process.cwd(),
      model: "gpt-5.5",
      reasoningEffort: "medium",
      stream: {
        onAssistantDelta: (text) => { assistantDeltas.push(text); },
        onThinkingDelta: (text) => { thinkingDeltas.push(text); }
      }
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.stream).toBe(true);
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
    expect(thinkingDeltas).toEqual(["checking"]);
    expect(assistantDeltas).toEqual(["ok"]);
    expect(JSON.parse(result.text).content).toEqual([{ type: "text", text: "ok" }]);
  });

  it("fails the request when the endpoint returns an http error", async () => {
    process.env.OPENCODE_TEST_KEY = "test-key";
    const body = JSON.stringify({ type: "error", error: { type: "CreditsError", message: "Insufficient balance." } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 401, headers: { "content-type": "text/plain" } })));

    const result = await runAnthropicMessagesProvider({ provider, prompt: "hello", cwd: process.cwd(), model: "claude-sonnet-5" });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("CreditsError");
  });

  it("fails the request when an error event arrives mid-stream on a 200", async () => {
    process.env.OPENCODE_TEST_KEY = "test-key";
    const sse = [
      event({ type: "message_start", message: { usage: { input_tokens: 2 } } }),
      event({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })
    ].join("");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(streamFromString(sse), { headers: { "content-type": "text/event-stream" } })));

    const result = await runAnthropicMessagesProvider({ provider, prompt: "hello", cwd: process.cwd(), model: "claude-sonnet-5" });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("overloaded_error: Overloaded");
  });

  it("returns streamed OpenAI chat deltas as the final assistant message", async () => {
    process.env.OPENCODE_TEST_KEY = "test-key";
    const sse = [
      event({ choices: [{ delta: { content: "Pong!" } }] }),
      event({ choices: [{ delta: { content: " Connected." }, finish_reason: "stop" }] })
    ].join("");
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(streamFromString(sse), { headers: { "content-type": "text/event-stream" } })));
    const assistantDeltas: string[] = [];

    const result = await runAnthropicMessagesProvider({
      provider: goProvider,
      prompt: "ping",
      cwd: process.cwd(),
      model: "kimi-k2.7",
      stream: {
        onAssistantDelta: (text) => { assistantDeltas.push(text); }
      }
    });

    expect(assistantDeltas).toEqual(["Pong!", " Connected."]);
    expect(JSON.parse(result.text).content).toEqual([{ type: "text", text: "Pong! Connected." }]);
  });

  it("preserves streamed Anthropic/OpenCode tool calls for the agent loop", async () => {
    process.env.OPENCODE_TEST_KEY = "test-key";
    const sse = [
      event({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call_1", name: "read", input: {} } }),
      event({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"path\":\"README.md\"}" } }),
      event({ type: "content_block_stop", index: 0 }),
      event({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
      event({ type: "message_stop" })
    ].join("");
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(streamFromString(sse), { headers: { "content-type": "text/event-stream" } })));

    const result = await runAnthropicMessagesProvider({
      provider,
      prompt: "read README",
      cwd: process.cwd(),
      model: "gpt-5.5"
    });

    const parsed = JSON.parse(result.text);
    expect(parsed.stopReason).toBe("tool_calls");
    expect(parsed.content).toEqual([{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "README.md" } }]);
  });

  it("normalizes streamed CrewCoder assistant JSON instead of rendering it as text", async () => {
    process.env.OPENCODE_TEST_KEY = "test-key";
    const assistant = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call_2", name: "read", arguments: { path: "README.md" } }],
      stopReason: "tool_calls",
      timestamp: Date.now()
    };
    const sse = [
      event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: JSON.stringify(assistant) } }),
      event({ type: "content_block_stop", index: 0 }),
      event({ type: "message_stop" })
    ].join("");
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(streamFromString(sse), { headers: { "content-type": "text/event-stream" } })));

    const result = await runAnthropicMessagesProvider({
      provider,
      prompt: "read README",
      cwd: process.cwd(),
      model: "minimax-m3"
    });

    const parsed = JSON.parse(result.text);
    expect(parsed.stopReason).toBe("tool_calls");
    expect(parsed.content).toEqual([{ type: "toolCall", id: "call_2", name: "read", arguments: { path: "README.md" } }]);
  });
});

function event(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function streamFromString(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    }
  });
}
