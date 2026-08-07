import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setAuthCredential } from "../providers/auth-store.js";
import { runCodexProvider } from "../providers/codex-provider.js";
import { closeCodexWebSocketSessions } from "../providers/codex-websocket-transport.js";
import type { ProviderDefinition } from "../providers/types.js";

const provider: ProviderDefinition = {
  id: "codex",
  title: "Codex Test",
  kind: "builtin",
  runtime: "openai-codex-responses",
  command: "http",
  args: [],
  endpoint: "https://example.test/codex/responses"
};

describe("codex provider", () => {
  afterEach(() => {
    closeCodexWebSocketSessions();
    FailingWebSocket.instances = 0;
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("uses the current first-party Codex request contract for GPT-5.6", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-codex-"));
    vi.stubEnv("CREWCODER_HOME", home);
    setAuthCredential("codex", { type: "oauth", access: "access-token", refresh: "refresh-token", expires: Date.now() + 600_000, accountId: "account-id" });
    let request: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      request = init;
      return new Response(streamFromString(event({ type: "response.output_text.delta", delta: "OK" })), { headers: { "content-type": "text/event-stream" } });
    }));

    const result = await runCodexProvider({ provider, prompt: "hello", cwd: process.cwd(), model: "gpt-5.6-luna", session: { sessionId: "session-123", continuation: false } });

    const headers = new Headers(request?.headers);
    const body = JSON.parse(String(request?.body)) as Record<string, unknown>;
    expect(result.exitCode).toBe(0);
    expect(headers.get("originator")).toBe("codex_cli_rs");
    expect(headers.get("accept")).toBe("text/event-stream");
    expect(headers.get("openai-beta")).toBeNull();
    expect(headers.get("session-id")).toBe("session-123");
    expect(headers.get("thread-id")).toBe("session-123");
    expect(body).toMatchObject({ model: "gpt-5.6-luna", tool_choice: "auto", prompt_cache_key: "session-123", client_metadata: { "session-id": "session-123", "thread-id": "session-123", "x-codex-window-id": "session-123" } });
  });

  // A tool result whose tool call was truncated away (compaction, branching, checkpoint
  // restore) used to be sent as an unmatched function_call_output. Codex answered with an
  // empty stream, which surfaced as "Codex stream ended without assistant text, tool calls,
  // or completion metadata" and repeated on every resume.
  it("never sends a function_call_output whose function_call is missing from the request", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-codex-"));
    vi.stubEnv("CREWCODER_HOME", home);
    setAuthCredential("codex", { type: "oauth", access: "access-token", refresh: "refresh-token", expires: Date.now() + 600_000, accountId: "account-id" });
    let request: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      request = init;
      return new Response(streamFromString(event({ type: "response.output_text.delta", delta: "OK" })), { headers: { "content-type": "text/event-stream" } });
    }));

    await runCodexProvider({
      provider,
      prompt: "continue",
      cwd: process.cwd(),
      model: "gpt-5.6-luna",
      session: { sessionId: "session-orphan", continuation: true },
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

    const body = JSON.parse(String(request?.body)) as { input: Array<Record<string, unknown>> };
    const outputs = body.input.filter((item) => item.type === "function_call_output");
    const calls = new Set(body.input.filter((item) => item.type === "function_call").map((item) => item.call_id));
    expect(outputs.map((item) => item.call_id)).toEqual(["call_kept"]);
    expect(outputs.every((item) => calls.has(item.call_id))).toBe(true);
    // The orphan is preserved as plain context instead of being silently dropped.
    expect(JSON.stringify(body.input)).toContain("Historical tool result from read");
  });

  it("prefers cached WebSocket transport for first-party session requests", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-codex-"));
    vi.stubEnv("CREWCODER_HOME", home);
    setAuthCredential("codex", { type: "oauth", access: "access-token", refresh: "refresh-token", expires: Date.now() + 600_000, accountId: "account-id" });
    vi.stubGlobal("WebSocket", AutoReplyWebSocket);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await runCodexProvider({
      provider: { ...provider, endpoint: undefined },
      prompt: "hello",
      cwd: process.cwd(),
      model: "gpt-5.6-luna",
      session: { sessionId: "session-websocket", continuation: false }
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.text).content).toEqual([{ type: "text", text: "WebSocket OK" }]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(AutoReplyWebSocket.lastRequest).toMatchObject({ type: "response.create", model: "gpt-5.6-luna" });
  });

  it("falls back to SSE when WebSocket connection fails before streaming", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-codex-"));
    vi.stubEnv("CREWCODER_HOME", home);
    setAuthCredential("codex", { type: "oauth", access: "access-token", refresh: "refresh-token", expires: Date.now() + 600_000, accountId: "account-id" });
    vi.stubGlobal("WebSocket", FailingWebSocket);
    const fetchMock = vi.fn(async () => new Response(streamFromString(event({ type: "response.output_text.delta", delta: "SSE fallback" })), { headers: { "content-type": "text/event-stream" } }));
    vi.stubGlobal("fetch", fetchMock);

    const request = {
      provider: { ...provider, endpoint: undefined },
      prompt: "hello",
      cwd: process.cwd(),
      model: "gpt-5.6-luna",
      session: { sessionId: "session-fallback", continuation: false }
    };
    const result = await runCodexProvider(request);
    await runCodexProvider(request);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.text).content).toEqual([{ type: "text", text: "SSE fallback" }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(FailingWebSocket.instances).toBe(1);
  });

  it("does not replay through SSE after WebSocket streaming starts", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-codex-"));
    vi.stubEnv("CREWCODER_HOME", home);
    setAuthCredential("codex", { type: "oauth", access: "access-token", refresh: "refresh-token", expires: Date.now() + 600_000, accountId: "account-id" });
    vi.stubGlobal("WebSocket", StreamingFailureWebSocket);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(runCodexProvider({
      provider: { ...provider, endpoint: undefined },
      prompt: "hello",
      cwd: process.cwd(),
      model: "gpt-5.6-luna",
      session: { sessionId: "session-stream-failure", continuation: false }
    })).rejects.toThrow("stream disconnected");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("encodes an image part as a Responses API input_image", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-codex-"));
    vi.stubEnv("CREWCODER_HOME", home);
    setAuthCredential("codex", { type: "oauth", access: "access-token", refresh: "refresh-token", expires: Date.now() + 600_000, accountId: "account-id" });
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
    const filePath = path.join(home, "shot.png");
    fs.writeFileSync(filePath, bytes);
    let request: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      request = init;
      return new Response(streamFromString(event({ type: "response.output_text.delta", delta: "OK" })), { headers: { "content-type": "text/event-stream" } });
    }));

    await runCodexProvider({
      provider,
      prompt: "what is this",
      cwd: process.cwd(),
      model: "gpt-5.6-luna",
      session: { sessionId: "session-123", continuation: false },
      modelInput: {
        systemPrompt: "system",
        messages: [{ role: "user", content: [{ type: "text", text: "what is this" }, { type: "image", mime: "image/png", path: filePath }], timestamp: Date.now() }],
        availableTools: []
      }
    });

    const body = JSON.parse(String(request?.body)) as { input: Array<{ role?: string; content?: unknown }> };
    const userItem = body.input.find((item) => item.role === "user");
    expect(userItem?.content).toEqual([
      { type: "input_text", text: "what is this" },
      { type: "input_image", image_url: `data:image/png;base64,${bytes.toString("base64")}` }
    ]);
  });

  it("treats an HTTP 200 SSE error event as a provider failure", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-codex-"));
    vi.stubEnv("CREWCODER_HOME", home);
    setAuthCredential("codex", { type: "oauth", access: "access-token", refresh: "refresh-token", expires: Date.now() + 600_000, accountId: "account-id" });
    const sse = event({ type: "error", error: { type: "server_error", message: "upstream overloaded" } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(streamFromString(sse), { headers: { "content-type": "text/event-stream" } })));

    const result = await runCodexProvider({ provider, prompt: "hello", cwd: process.cwd(), model: "gpt-5.6-luna" });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("server_error: upstream overloaded");
    expect(result.text).not.toContain("empty Codex response");
  });

  it("recovers final output_text.done from a stream without a trailing SSE boundary", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-codex-"));
    vi.stubEnv("CREWCODER_HOME", home);
    setAuthCredential("codex", { type: "oauth", access: "access-token", refresh: "refresh-token", expires: Date.now() + 600_000, accountId: "account-id" });
    const sse = `data: ${JSON.stringify({ type: "response.output_text.done", text: "Recovered" })}`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(streamFromString(sse), { headers: { "content-type": "text/event-stream" } })));

    const result = await runCodexProvider({ provider, prompt: "hello", cwd: process.cwd(), model: "gpt-5.6-luna" });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.text).content).toEqual([{ type: "text", text: "Recovered" }]);
  });

  it("preserves the nested transport cause after spaced network retries", async () => {
    vi.useFakeTimers();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-codex-"));
    vi.stubEnv("CREWCODER_HOME", home);
    setAuthCredential("codex", { type: "oauth", access: "access-token", refresh: "refresh-token", expires: Date.now() + 600_000, accountId: "account-id" });
    const socketError = Object.assign(new Error("write ECONNRESET"), { code: "ECONNRESET" });
    const fetchError = new TypeError("fetch failed", { cause: socketError });
    const fetchMock = vi.fn(async () => { throw fetchError; });
    vi.stubGlobal("fetch", fetchMock);

    const request = runCodexProvider({ provider, prompt: "x".repeat(530 * 1024), cwd: process.cwd(), model: "gpt-5.6-luna" });
    const rejection = expect(request).rejects.toThrow(/Codex request failed after 3 attempts: fetch failed; caused by ECONNRESET: write ECONNRESET.*run \/compact/);
    await vi.runAllTimersAsync();
    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("fails a stream that ends without output or completion metadata", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-codex-"));
    vi.stubEnv("CREWCODER_HOME", home);
    setAuthCredential("codex", { type: "oauth", access: "access-token", refresh: "refresh-token", expires: Date.now() + 600_000, accountId: "account-id" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(streamFromString("data: [DONE]\n\n"), { headers: { "content-type": "text/event-stream" } })));

    const result = await runCodexProvider({ provider, prompt: "hello", cwd: process.cwd(), model: "gpt-5.6-luna" });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("without assistant text, tool calls, or completion metadata");
  });

  it("emits reasoning summaries from completed reasoning output items", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-codex-"));
    vi.stubEnv("CREWCODER_HOME", home);
    setAuthCredential("codex", { type: "oauth", access: "access-token", refresh: "refresh-token", expires: Date.now() + 600_000, accountId: "account-id" });
    const sse = [
      event({ type: "response.output_text.delta", delta: "Done" }),
      event({ type: "response.reasoning_summary_text.delta", delta: "Checked Codex reasoning." }),
      event({ type: "response.reasoning_summary_text.done", text: "Checked Codex reasoning." }),
      event({ type: "response.output_item.done", item: { type: "reasoning", summary: [{ type: "summary_text", text: "Checked Codex reasoning." }] } }),
      event({ type: "response.completed", response: { model: "gpt-5.4-mini", output: [{ type: "reasoning", summary: [{ type: "summary_text", text: "Checked Codex reasoning." }] }], usage: { input_tokens: 3, output_tokens: 5, output_tokens_details: { reasoning_tokens: 2 } } } })
    ].join("");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(streamFromString(sse), { headers: { "content-type": "text/event-stream" } })));
    const thinkingDeltas: string[] = [];

    const result = await runCodexProvider({
      provider,
      prompt: "hello",
      cwd: process.cwd(),
      model: "gpt-5.4-mini",
      reasoningEffort: "medium",
      stream: { onThinkingDelta: (text) => { thinkingDeltas.push(text); } }
    });

    expect(result.exitCode).toBe(0);
    expect(thinkingDeltas).toEqual(["Checked Codex reasoning."]);
    expect(JSON.parse(result.text).content).toEqual([{ type: "text", text: "Done" }]);
  });
});

type WebSocketTestListener = (event: unknown) => void;

class AutoReplyWebSocket {
  static lastRequest: Record<string, unknown> | undefined;
  readonly listeners = new Map<string, Set<WebSocketTestListener>>();
  readyState = 0;

  constructor() {
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit("open", {});
    });
  }

  addEventListener(type: string, listener: WebSocketTestListener): void {
    const listeners = this.listeners.get(type) ?? new Set<WebSocketTestListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: WebSocketTestListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    AutoReplyWebSocket.lastRequest = JSON.parse(data) as Record<string, unknown>;
    queueMicrotask(() => {
      this.emit("message", { data: JSON.stringify({ type: "response.output_text.delta", delta: "WebSocket OK" }) });
      this.emit("message", { data: JSON.stringify({ type: "response.completed", response: { id: "response-ws", output: [] } }) });
    });
  }

  close(): void {
    this.readyState = 3;
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class FailingWebSocket {
  static instances = 0;
  readonly listeners = new Map<string, Set<WebSocketTestListener>>();
  readyState = 0;

  constructor() {
    FailingWebSocket.instances += 1;
    queueMicrotask(() => this.emit("error", { error: new Error("connect failed") }));
  }

  addEventListener(type: string, listener: WebSocketTestListener): void {
    const listeners = this.listeners.get(type) ?? new Set<WebSocketTestListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: WebSocketTestListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(): void {}
  close(): void { this.readyState = 3; }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class StreamingFailureWebSocket extends AutoReplyWebSocket {
  override send(): void {
    queueMicrotask(() => {
      this.emitForTest("message", { data: JSON.stringify({ type: "response.output_text.delta", delta: "partial" }) });
      this.emitForTest("error", { error: new Error("stream disconnected") });
    });
  }

  private emitForTest(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

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
