import { afterEach, describe, expect, it, vi } from "vitest";
import { closeCodexWebSocketSessions, requestCodexWebSocket } from "../providers/codex-websocket-transport.js";

type Listener = (event: unknown) => void;

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  readonly sent: Array<Record<string, unknown>> = [];
  readonly listeners = new Map<string, Set<Listener>>();
  readyState = 0;

  constructor(readonly url: string, readonly options?: { headers?: Record<string, string> }) {
    MockWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit("open", {});
    });
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {
    this.readyState = 3;
  }

  message(event: Record<string, unknown>): void {
    this.emit("message", { data: JSON.stringify(event) });
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

describe("Codex WebSocket transport", () => {
  afterEach(() => {
    closeCodexWebSocketSessions();
    MockWebSocket.instances = [];
    vi.unstubAllGlobals();
  });

  it("reuses a session connection and sends only the continuation delta", async () => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    const headers = new Headers({ authorization: "Bearer token", "content-type": "application/json" });
    const initialUser = { role: "user", content: "start" };
    const assistant = { role: "assistant", content: "working" };
    const toolResult = { type: "function_call_output", call_id: "call-1", output: "done" };
    const body = { model: "gpt-test", store: false, stream: true, input: [initialUser] };

    const first = await requestCodexWebSocket({
      endpoint: "https://chatgpt.com/backend-api/codex/responses",
      headers,
      body,
      sessionId: "session-1"
    });
    const firstSocket = MockWebSocket.instances[0]!;
    expect(firstSocket.options?.headers?.["openai-beta"]).toBe("responses_websockets=2026-02-06");
    expect(firstSocket.sent[0]).toMatchObject({ type: "response.create", input: [initialUser] });
    firstSocket.message({ type: "response.completed", response: { id: "response-1", output: [] } });
    await first.response.text();
    first.commit("response-1", [assistant]);

    const second = await requestCodexWebSocket({
      endpoint: "https://chatgpt.com/backend-api/codex/responses",
      headers,
      body: { ...body, input: [initialUser, assistant, toolResult] },
      sessionId: "session-1"
    });

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(firstSocket.sent[1]).toMatchObject({
      type: "response.create",
      previous_response_id: "response-1",
      input: [toolResult]
    });
    firstSocket.message({ type: "response.completed", response: { id: "response-2", output: [] } });
    await second.response.text();
    second.commit("response-2", []);
  });

  it("drops cached continuation when stable request fields change", async () => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    const headers = new Headers({ authorization: "Bearer token" });
    const first = await requestCodexWebSocket({
      endpoint: "https://chatgpt.com/backend-api/codex/responses",
      headers,
      body: { model: "model-a", input: [{ role: "user", content: "start" }] },
      sessionId: "session-2"
    });
    const socket = MockWebSocket.instances[0]!;
    socket.message({ type: "response.completed", response: { id: "response-1", output: [] } });
    await first.response.text();
    first.commit("response-1", [{ role: "assistant", content: "done" }]);

    const second = await requestCodexWebSocket({
      endpoint: "https://chatgpt.com/backend-api/codex/responses",
      headers,
      body: { model: "model-b", input: [{ role: "user", content: "start" }, { role: "assistant", content: "done" }] },
      sessionId: "session-2"
    });

    expect(socket.sent[1]).not.toHaveProperty("previous_response_id");
    expect(socket.sent[1]).toMatchObject({ model: "model-b", input: [{ role: "user", content: "start" }, { role: "assistant", content: "done" }] });
    second.discard();
  });
});
