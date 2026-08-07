import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runOpenAIResponsesProvider } from "../providers/openai-responses-provider.js";
import type { ProviderDefinition } from "../providers/types.js";

const provider: ProviderDefinition = {
  id: "openai-test",
  title: "OpenAI Test",
  kind: "builtin",
  runtime: "openai-responses",
  command: "",
  args: [],
  endpoint: "https://example.test/v1/responses",
  apiKeyEnv: "OPENAI_TEST_KEY"
};

describe("openai responses provider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.OPENAI_TEST_KEY;
  });

  it("streams assistant, thinking, and tool-call deltas from SSE events", async () => {
    process.env.OPENAI_TEST_KEY = "test-key";
    const sse = [
      event({ type: "response.output_text.delta", delta: "Hel" }),
      event({ type: "response.reasoning_summary_text.delta", delta: "thinking" }),
      event({ type: "response.output_text.delta", delta: "lo" }),
      event({ type: "response.output_item.added", item: { type: "function_call", call_id: "call_1", name: "read" } }),
      event({ type: "response.function_call_arguments.delta", item_id: "call_1", delta: "{\"path\":" }),
      event({ type: "response.function_call_arguments.delta", item_id: "call_1", delta: "\"README.md\"}" }),
      event({ type: "response.completed", response: { model: "gpt-5", usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 1 } } } }),
      "data: [DONE]\n\n"
    ].join("");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(streamFromString(sse), { headers: { "content-type": "text/event-stream" } })));

    const assistantDeltas: string[] = [];
    const thinkingDeltas: string[] = [];
    const result = await runOpenAIResponsesProvider({
      provider,
      prompt: "hello",
      cwd: process.cwd(),
      model: "gpt-5",
      stream: {
        onAssistantDelta: (text) => { assistantDeltas.push(text); },
        onThinkingDelta: (text) => { thinkingDeltas.push(text); }
      }
    });

    expect(result.exitCode).toBe(0);
    expect(assistantDeltas).toEqual(["Hel", "lo"]);
    expect(thinkingDeltas).toEqual(["thinking"]);
    const parsed = JSON.parse(result.text);
    expect(parsed.content).toEqual([
      { type: "text", text: "Hello" },
      { type: "toolCall", id: "call_1", name: "read", arguments: { path: "README.md" } }
    ]);
    expect(parsed.stopReason).toBe("tool_calls");
    expect(result.usage).toMatchObject({ providerId: "openai-test", model: "gpt-5", inputTokens: 10, outputTokens: 5, totalTokens: 15, cachedInputTokens: 2, reasoningTokens: 1 });
  });

  it("treats an HTTP 200 streamed provider error as failure", async () => {
    process.env.OPENAI_TEST_KEY = "test-key";
    const sse = event({ type: "response.failed", response: { error: { code: "server_error", message: "upstream failed" } } }).trimEnd();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(streamFromString(sse), { headers: { "content-type": "text/event-stream" } })));

    const result = await runOpenAIResponsesProvider({ provider, prompt: "hello", cwd: process.cwd(), model: "gpt-5" });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("upstream failed");
  });

  it("converts non-stream response JSON to CrewCoder assistant JSON", async () => {
    process.env.OPENAI_TEST_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      output: [
        { type: "message", content: [{ type: "output_text", text: "Done" }] },
        { type: "function_call", call_id: "call_2", name: "write", arguments: "{\"path\":\"a.txt\"}" }
      ],
      usage: { input_tokens: 20, output_tokens: 7, total_tokens: 27 }
    }), { headers: { "content-type": "application/json" } })));

    const result = await runOpenAIResponsesProvider({
      provider: { ...provider, capabilities: { parallelToolCalls: true } },
      prompt: "hello",
      cwd: process.cwd(),
      model: "gpt-5",
      modelInput: {
        systemPrompt: "system",
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() }],
        availableTools: [{ name: "write", description: "Write", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false } }]
      }
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.text);
    expect(parsed.content).toEqual([
      { type: "text", text: "Done" },
      { type: "toolCall", id: "call_2", name: "write", arguments: { path: "a.txt" } }
    ]);
    expect(result.usage).toMatchObject({ providerId: "openai-test", model: "gpt-5", inputTokens: 20, outputTokens: 7, totalTokens: 27 });
    const init = (vi.mocked(fetch).mock.calls[0]?.[1]) as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.parallel_tool_calls).toBe(true);
    expect(body.tools[0].parameters).toEqual({ type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false });
  });

  it("encodes an image part as a Responses API input_image", async () => {
    process.env.OPENAI_TEST_KEY = "test-key";
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
    const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-vision-")), "shot.png");
    fs.writeFileSync(filePath, bytes);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] }), { headers: { "content-type": "application/json" } })));

    await runOpenAIResponsesProvider({
      provider,
      prompt: "what is this",
      cwd: process.cwd(),
      model: "gpt-5",
      modelInput: {
        systemPrompt: "system",
        messages: [{ role: "user", content: [{ type: "text", text: "what is this" }, { type: "image", mime: "image/png", path: filePath }], timestamp: Date.now() }],
        availableTools: []
      }
    });

    const body = JSON.parse(String(((vi.mocked(fetch).mock.calls[0]?.[1]) as RequestInit).body));
    const userItem = body.input.find((item: { role?: string }) => item.role === "user");
    expect(userItem.content).toEqual([
      { type: "input_text", text: "what is this" },
      { type: "input_image", image_url: `data:image/png;base64,${bytes.toString("base64")}` }
    ]);
  });

  it("emits final reasoning summaries from completed responses", async () => {
    process.env.OPENAI_TEST_KEY = "test-key";
    const sse = [
      event({ type: "response.output_text.delta", delta: "Done" }),
      event({
        type: "response.completed",
        response: {
          model: "gpt-5",
          output: [{ type: "reasoning", summary: [{ type: "summary_text", text: "Checked the arithmetic." }] }],
          usage: { input_tokens: 5, output_tokens: 3, output_tokens_details: { reasoning_tokens: 2 } }
        }
      })
    ].join("");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(streamFromString(sse), { headers: { "content-type": "text/event-stream" } })));
    const thinkingDeltas: string[] = [];

    await runOpenAIResponsesProvider({
      provider,
      prompt: "hello",
      cwd: process.cwd(),
      model: "gpt-5",
      stream: { onThinkingDelta: (text) => { thinkingDeltas.push(text); } }
    });

    expect(thinkingDeltas).toEqual(["Checked the arithmetic.\n\n"]);
  });

  it("deduplicates reasoning summaries repeated across stream event shapes", async () => {
    process.env.OPENAI_TEST_KEY = "test-key";
    const summary = "Checked the arithmetic.";
    const sse = [
      event({ type: "response.output_text.delta", delta: "Done" }),
      event({ type: "response.reasoning_summary_text.delta", delta: summary }),
      event({ type: "response.reasoning_summary_text.done", text: summary }),
      event({ type: "response.output_item.done", item: { type: "reasoning", summary: [{ type: "summary_text", text: summary }] } }),
      event({ type: "response.completed", response: { model: "gpt-5", output: [{ type: "reasoning", summary: [{ type: "summary_text", text: summary }] }] } })
    ].join("");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(streamFromString(sse), { headers: { "content-type": "text/event-stream" } })));
    const thinkingDeltas: string[] = [];

    await runOpenAIResponsesProvider({
      provider,
      prompt: "hello",
      cwd: process.cwd(),
      model: "gpt-5",
      stream: { onThinkingDelta: (text) => { thinkingDeltas.push(text); } }
    });

    expect(thinkingDeltas).toEqual([summary]);
  });
});

function event(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function streamFromString(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    }
  });
}
