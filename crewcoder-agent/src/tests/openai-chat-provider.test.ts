import { afterEach, describe, expect, it, vi } from "vitest";
import { runHttpMessagesProvider as runAnthropicMessagesProvider } from "../providers/http-provider.js";
import type { ProviderDefinition } from "../providers/types.js";

const provider: ProviderDefinition = {
  id: "chat-test",
  title: "Chat Test",
  kind: "builtin",
  runtime: "openai-chat-completions",
  command: "http",
  args: [],
  endpoint: "https://example.test/v1/chat/completions",
  apiKeyEnv: "CHAT_TEST_API_KEY"
};

describe("OpenAI-compatible Chat Completions provider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("uses Chat Completions shape based on runtime rather than model-name heuristics", async () => {
    vi.stubEnv("CHAT_TEST_API_KEY", "test-key");
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await runAnthropicMessagesProvider({
      provider,
      prompt: "inspect",
      cwd: process.cwd(),
      model: "grok-4.1-fast",
      modelInput: {
        systemPrompt: "system",
        messages: [{ role: "user", content: [{ type: "text", text: "inspect" }], timestamp: Date.now() }],
        availableTools: [{
          name: "read",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false }
        }]
      }
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;
    const body = JSON.parse(String(init?.body));
    expect(String(url)).toBe(provider.endpoint);
    expect(headers.authorization).toBe("Bearer test-key");
    expect(headers["anthropic-version"]).toBeUndefined();
    expect(body).toMatchObject({
      model: "grok-4.1-fast",
      stream: true,
      messages: [{ role: "system", content: "system" }, { role: "user", content: "inspect" }]
    });
    expect(body.tools[0]).toEqual({
      type: "function",
      function: {
        name: "read",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false }
      }
    });
    expect(body.parallel_tool_calls).toBeUndefined();
  });

  it("requests parallel tool calls only when the provider or selected model advertises support", async () => {
    vi.stubEnv("CHAT_TEST_API_KEY", "test-key");
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const modelInput = {
      systemPrompt: "system",
      messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "inspect" }], timestamp: Date.now() }],
      availableTools: [{ name: "read", description: "Read a file" }]
    };

    await runAnthropicMessagesProvider({
      provider: { ...provider, capabilities: { parallelToolCalls: true } },
      prompt: "inspect",
      cwd: process.cwd(),
      model: "parallel-model",
      modelInput
    });
    await runAnthropicMessagesProvider({
      provider: { ...provider, capabilities: { parallelToolCalls: true }, modelCatalog: [{ id: "sequential-model", parallelToolCalls: false }] },
      prompt: "inspect",
      cwd: process.cwd(),
      model: "sequential-model",
      modelInput
    });

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).parallel_tool_calls).toBe(true);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)).parallel_tool_calls).toBeUndefined();
  });

  it("streams reasoning, tool calls, and final usage", async () => {
    vi.stubEnv("CHAT_TEST_API_KEY", "test-key");
    const sse = [
      event({ choices: [{ delta: { reasoning_content: "checking" } }] }),
      event({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "read", arguments: "{\"path\":" } }] } }] }),
      event({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"README.md\"}" } }] }, finish_reason: "tool_calls" }] }),
      event({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } })
    ].join("");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(streamFromString(sse), { headers: { "content-type": "text/event-stream" } })));
    const thinking: string[] = [];

    const result = await runAnthropicMessagesProvider({
      provider,
      prompt: "read",
      cwd: process.cwd(),
      model: "model-1",
      stream: { onThinkingDelta: (delta) => { thinking.push(delta); } }
    });

    expect(thinking).toEqual(["checking"]);
    expect(result.usage).toMatchObject({ inputTokens: 12, outputTokens: 4, totalTokens: 16 });
    expect(JSON.parse(result.text)).toMatchObject({
      stopReason: "tool_calls",
      content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } }]
    });
  });

  it("treats an OpenAI-compatible streamed error envelope as failure", async () => {
    vi.stubEnv("CHAT_TEST_API_KEY", "test-key");
    const sse = event({ error: { type: "server_error", message: "upstream unavailable" } }).trimEnd();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(streamFromString(sse), { headers: { "content-type": "text/event-stream" } })));

    const result = await runAnthropicMessagesProvider({ provider, prompt: "hello", cwd: process.cwd(), model: "model-1" });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("server_error: upstream unavailable");
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
