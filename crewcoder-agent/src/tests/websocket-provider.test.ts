import { afterEach, describe, expect, it, vi } from "vitest";
import { runWebSocketProvider } from "../providers/websocket-provider.js";
import type { ProviderDefinition } from "../providers/types.js";

const provider: ProviderDefinition = {
  id: "ws-test",
  title: "WebSocket Test",
  kind: "builtin",
  runtime: "websocket",
  command: "",
  args: [],
  endpoint: "ws://example.test/model",
  apiKeyEnv: "WS_TEST_KEY"
};

describe("websocket provider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    MockWebSocket.nextMessages = [];
    MockWebSocket.sent = [];
    delete process.env.WS_TEST_KEY;
  });

  it("streams simple WebSocket assistant and thinking deltas", async () => {
    process.env.WS_TEST_KEY = "test-key";
    MockWebSocket.nextMessages = [
      { type: "assistant_delta", delta: "Hel" },
      { type: "thinking_delta", text: "thinking" },
      { type: "assistant_delta", text: "lo" },
      { type: "tool_call", id: "call_1", name: "read", arguments: { path: "README.md" } },
      { type: "usage", usage: { input_tokens: 11, output_tokens: 4, total_tokens: 15 } },
      { type: "done" }
    ];
    vi.stubGlobal("WebSocket", MockWebSocket);

    const assistantDeltas: string[] = [];
    const thinkingDeltas: string[] = [];
    const result = await runWebSocketProvider({
      provider,
      prompt: "hello",
      cwd: process.cwd(),
      model: "ws-model",
      modelInput: {
        systemPrompt: "system",
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() }],
        availableTools: [{ name: "read", description: "Read", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } }]
      },
      stream: {
        onAssistantDelta: (text) => { assistantDeltas.push(text); },
        onThinkingDelta: (text) => { thinkingDeltas.push(text); }
      }
    });

    expect(assistantDeltas).toEqual(["Hel", "lo"]);
    expect(thinkingDeltas).toEqual(["thinking"]);
    const sent = JSON.parse(MockWebSocket.sent[0]!);
    expect(sent).toMatchObject({ type: "request", model: "ws-model", prompt: "hello", stream: true, apiKey: "test-key" });
    expect(sent.tools[0].parameters).toEqual({ type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false });
    const parsed = JSON.parse(result.text);
    expect(parsed.content).toEqual([
      { type: "text", text: "Hello" },
      { type: "toolCall", id: "call_1", name: "read", arguments: { path: "README.md" } }
    ]);
    expect(parsed.stopReason).toBe("tool_calls");
    expect(result.usage).toMatchObject({ providerId: "ws-test", model: "ws-model", inputTokens: 11, outputTokens: 4, totalTokens: 15 });
  });

  it("sends session continuation metadata for cached WebSocket context", async () => {
    MockWebSocket.nextMessages = [{ type: "done" }];
    vi.stubGlobal("WebSocket", MockWebSocket);

    await runWebSocketProvider({
      provider: { ...provider, apiKeyEnv: undefined },
      prompt: "next",
      cwd: process.cwd(),
      model: "ws-model",
      session: { sessionId: "session_next", resumeFromSessionId: "session_prev", continuation: true },
      modelInput: {
        systemPrompt: "system",
        messages: [
          { role: "user", content: [{ type: "text", text: "before" }], timestamp: 1 },
          { role: "user", content: [{ type: "text", text: "next" }], timestamp: 2 }
        ],
        availableTools: []
      }
    });

    const sent = JSON.parse(MockWebSocket.sent[0]!);
    expect(sent).toMatchObject({
      sessionId: "session_next",
      resumeFromSessionId: "session_prev",
      continuation: true,
      contextCache: { enabled: true, key: "session_prev" }
    });
  });

  // Compaction, branching, and checkpoint restores can truncate a transcript mid tool
  // group. An unmatched function_call_output is a protocol error the model answers with
  // an empty turn, so the orphan is degraded to plain context instead.
  it("never sends a function_call_output whose function_call is missing from the request", async () => {
    MockWebSocket.nextMessages = [{ type: "done" }];
    vi.stubGlobal("WebSocket", MockWebSocket);

    await runWebSocketProvider({
      provider: { ...provider, apiKeyEnv: undefined },
      prompt: "continue",
      cwd: process.cwd(),
      model: "ws-model",
      modelInput: {
        systemPrompt: "system",
        availableTools: [],
        messages: [
          { role: "user", content: [{ type: "text", text: "Background from compacted earlier session:\nsummary" }], timestamp: 1 },
          { role: "toolResult", toolCallId: "call_dropped", toolName: "read", content: [{ type: "text", text: "orphaned output" }], isError: false, timestamp: 2 },
          { role: "assistant", content: [{ type: "toolCall", id: "call_kept", name: "edit", arguments: {} }], stopReason: "tool_calls", timestamp: 3 },
          { role: "toolResult", toolCallId: "call_kept", toolName: "edit", content: [{ type: "text", text: "kept output" }], isError: false, timestamp: 4 }
        ]
      }
    });

    const sent = JSON.parse(MockWebSocket.sent[0]!) as { input: Array<Record<string, unknown>> };
    const outputs = sent.input.filter((item) => item.type === "function_call_output");
    const calls = new Set(sent.input.filter((item) => item.type === "function_call").map((item) => item.call_id));
    expect(outputs.map((item) => item.call_id)).toEqual(["call_kept"]);
    expect(outputs.every((item) => calls.has(item.call_id))).toBe(true);
    // The orphan is preserved as plain context instead of being silently dropped.
    expect(JSON.stringify(sent.input)).toContain("Historical tool result from read");
  });

  it("parses OpenAI Responses-style WebSocket events", async () => {
    MockWebSocket.nextMessages = [
      { type: "response.output_text.delta", delta: "Done" },
      { type: "response.output_item.added", item: { type: "function_call", call_id: "call_2", name: "write" } },
      { type: "response.function_call_arguments.delta", item_id: "call_2", delta: "{\"path\":\"a.txt\"}" },
      { type: "response.completed", response: { output_text: "ignored because text already streamed", usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } }
    ];
    vi.stubGlobal("WebSocket", MockWebSocket);

    const result = await runWebSocketProvider({ provider: { ...provider, apiKeyEnv: undefined }, prompt: "hello", cwd: process.cwd(), model: "ws-model" });

    const parsed = JSON.parse(result.text);
    expect(parsed.content).toEqual([
      { type: "text", text: "Done" },
      { type: "toolCall", id: "call_2", name: "write", arguments: { path: "a.txt" } }
    ]);
    expect(result.usage).toMatchObject({ providerId: "ws-test", model: "ws-model", inputTokens: 3, outputTokens: 2, totalTokens: 5 });
  });
});

class MockWebSocket extends EventTarget {
  static nextMessages: Array<Record<string, unknown> | string> = [];
  static sent: string[] = [];

  readonly url: string;

  constructor(url: string) {
    super();
    this.url = url;
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }

  send(data: string): void {
    MockWebSocket.sent.push(data);
    queueMicrotask(() => {
      for (const message of MockWebSocket.nextMessages) {
        this.dispatchEvent(new MessageEvent("message", { data: typeof message === "string" ? message : JSON.stringify(message) }));
      }
      this.dispatchEvent(new Event("close"));
    });
  }

  close(): void {
    this.dispatchEvent(new Event("close"));
  }
}
