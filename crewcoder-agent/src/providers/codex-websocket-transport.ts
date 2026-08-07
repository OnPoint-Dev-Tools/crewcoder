import { createHash } from "node:crypto";

type CodexWebSocketRequestBody = Record<string, unknown> & {
  input?: unknown[];
  previous_response_id?: string;
};

type WebSocketEventType = "open" | "message" | "error" | "close";
type WebSocketListener = (event: unknown) => void;
type WebSocketLike = {
  readonly readyState?: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: WebSocketEventType, listener: WebSocketListener): void;
  removeEventListener(type: WebSocketEventType, listener: WebSocketListener): void;
};
type WebSocketConstructor = new (url: string, protocols?: string | string[] | { headers?: Record<string, string> }) => WebSocketLike;

type ContinuationState = {
  requestBody: CodexWebSocketRequestBody;
  responseId: string;
  assistantItems: unknown[];
};

type CachedConnection = {
  socket: WebSocketLike;
  busy: boolean;
  headerIdentity: string;
  continuation?: ContinuationState;
  idleTimer?: ReturnType<typeof setTimeout>;
};

export type CodexWebSocketRequest = {
  response: Response;
  started(): boolean;
  commit(responseId: string | undefined, assistantItems: unknown[]): void;
  discard(): void;
};

const CONNECT_TIMEOUT_MS = 15_000;
const SESSION_CACHE_TTL_MS = 5 * 60 * 1000;
const sessionConnections = new Map<string, CachedConnection>();
const sseFallbackSessions = new Set<string>();

export async function requestCodexWebSocket(input: {
  endpoint: string;
  headers: Headers;
  body: CodexWebSocketRequestBody;
  sessionId: string;
  signal?: AbortSignal;
}): Promise<CodexWebSocketRequest> {
  const acquired = await acquireConnection(toWebSocketUrl(input.endpoint), input.headers, input.sessionId, input.signal);
  const requestBody = acquired.entry ? cachedRequestBody(input.body, acquired.entry.continuation) : input.body;
  let eventReceived = false;
  let settled = false;
  let released = false;
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const encoder = new TextEncoder();

  const cleanupListeners = () => {
    acquired.socket.removeEventListener("message", onMessage);
    acquired.socket.removeEventListener("error", onError);
    acquired.socket.removeEventListener("close", onClose);
    input.signal?.removeEventListener("abort", onAbort);
  };
  const failStream = (error: Error) => {
    if (settled) return;
    settled = true;
    cleanupListeners();
    try { streamController?.error(error); } catch {}
  };
  const closeStream = () => {
    if (settled) return;
    settled = true;
    cleanupListeners();
    try { streamController?.close(); } catch {}
  };
  const enqueueEvent = (data: string) => {
    if (settled) return;
    eventReceived = true;
    streamController?.enqueue(encoder.encode(`data: ${data}\n\n`));
    if (isTerminalEvent(data)) closeStream();
  };
  const onMessage: WebSocketListener = (event) => {
    const raw = event && typeof event === "object" && "data" in event
      ? (event as { data?: unknown }).data
      : undefined;
    if (typeof raw === "string") {
      enqueueEvent(raw);
      return;
    }
    void webSocketDataToString(raw).then((data) => {
      if (data !== undefined) enqueueEvent(data);
    }).catch((error: unknown) => {
      failStream(error instanceof Error ? error : new Error(String(error)));
    });
  };
  const onError: WebSocketListener = (event) => failStream(webSocketEventError(event));
  const onClose: WebSocketListener = (event) => {
    if (!settled) failStream(webSocketCloseError(event));
  };
  const onAbort = () => {
    closeSocket(acquired.socket, 1000, "aborted");
    failStream(new Error("Request was aborted"));
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      acquired.socket.addEventListener("message", onMessage);
      acquired.socket.addEventListener("error", onError);
      acquired.socket.addEventListener("close", onClose);
      input.signal?.addEventListener("abort", onAbort, { once: true });
      if (input.signal?.aborted) {
        onAbort();
        return;
      }
      try {
        acquired.socket.send(JSON.stringify({ type: "response.create", ...requestBody }));
      } catch (error) {
        failStream(error instanceof Error ? error : new Error(String(error)));
      }
    },
    cancel() {
      cleanupListeners();
    }
  });

  const release = (keep: boolean) => {
    if (released) return;
    released = true;
    cleanupListeners();
    acquired.release(keep);
  };

  return {
    response: new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
    started: () => eventReceived,
    commit(responseId, assistantItems) {
      if (acquired.entry) {
        acquired.entry.continuation = responseId
          ? { requestBody: input.body, responseId, assistantItems }
          : undefined;
      }
      release(true);
    },
    discard() {
      if (acquired.entry) acquired.entry.continuation = undefined;
      release(false);
    }
  };
}

export function disableCodexWebSocketSession(sessionId: string): void {
  sseFallbackSessions.add(sessionId);
  const entry = sessionConnections.get(sessionId);
  if (entry) closeCachedConnection(sessionId, entry);
}

export function isCodexWebSocketSessionDisabled(sessionId: string): boolean {
  return sseFallbackSessions.has(sessionId);
}

export function closeCodexWebSocketSessions(sessionId?: string): void {
  if (sessionId) {
    const entry = sessionConnections.get(sessionId);
    if (entry) closeCachedConnection(sessionId, entry);
    sseFallbackSessions.delete(sessionId);
    return;
  }
  for (const [id, entry] of sessionConnections) closeCachedConnection(id, entry);
  sseFallbackSessions.clear();
}

function cachedRequestBody(body: CodexWebSocketRequestBody, continuation: ContinuationState | undefined): CodexWebSocketRequestBody {
  if (!continuation || !requestBodiesMatchExceptInput(body, continuation.requestBody)) return body;
  const input = body.input ?? [];
  const baseline = [...(continuation.requestBody.input ?? []), ...continuation.assistantItems];
  if (input.length < baseline.length || !itemsEqual(input.slice(0, baseline.length), baseline)) return body;
  return { ...body, previous_response_id: continuation.responseId, input: input.slice(baseline.length) };
}

function requestBodiesMatchExceptInput(left: CodexWebSocketRequestBody, right: CodexWebSocketRequestBody): boolean {
  const { input: _leftInput, previous_response_id: _leftPrevious, ...leftRest } = left;
  const { input: _rightInput, previous_response_id: _rightPrevious, ...rightRest } = right;
  return JSON.stringify(leftRest) === JSON.stringify(rightRest);
}

function itemsEqual(left: unknown[], right: unknown[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function acquireConnection(url: string, headers: Headers, sessionId: string, signal?: AbortSignal): Promise<{
  socket: WebSocketLike;
  entry?: CachedConnection;
  release(keep: boolean): void;
}> {
  const cached = sessionConnections.get(sessionId);
  const requestedHeaderIdentity = headerIdentity(headers);
  if (cached?.idleTimer) {
    clearTimeout(cached.idleTimer);
    cached.idleTimer = undefined;
  }
  if (cached && cached.headerIdentity === requestedHeaderIdentity && !cached.busy && isOpen(cached.socket)) {
    cached.busy = true;
    return { socket: cached.socket, entry: cached, release: (keep) => releaseCached(sessionId, cached, keep) };
  }
  if (cached && !cached.busy) closeCachedConnection(sessionId, cached);

  const socket = await connectWebSocket(url, headers, signal);
  if (cached?.busy) {
    return { socket, release: () => closeSocket(socket) };
  }
  const entry: CachedConnection = { socket, busy: true, headerIdentity: requestedHeaderIdentity };
  sessionConnections.set(sessionId, entry);
  return { socket, entry, release: (keep) => releaseCached(sessionId, entry, keep) };
}

function releaseCached(sessionId: string, entry: CachedConnection, keep: boolean): void {
  if (!keep || !isOpen(entry.socket)) {
    closeCachedConnection(sessionId, entry);
    return;
  }
  entry.busy = false;
  entry.idleTimer = setTimeout(() => {
    if (!entry.busy) closeCachedConnection(sessionId, entry);
  }, SESSION_CACHE_TTL_MS);
  entry.idleTimer.unref?.();
}

function closeCachedConnection(sessionId: string, entry: CachedConnection): void {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  closeSocket(entry.socket);
  if (sessionConnections.get(sessionId) === entry) sessionConnections.delete(sessionId);
}

async function connectWebSocket(url: string, headers: Headers, signal?: AbortSignal): Promise<WebSocketLike> {
  const ctor = (globalThis as { WebSocket?: unknown }).WebSocket;
  if (typeof ctor !== "function") throw new Error("WebSocket transport is unavailable in this runtime");
  const WebSocketCtor = ctor as WebSocketConstructor;
  const headerRecord = Object.fromEntries(headers.entries());
  delete headerRecord.accept;
  delete headerRecord["content-type"];
  headerRecord["openai-beta"] = "responses_websockets=2026-02-06";

  return new Promise<WebSocketLike>((resolve, reject) => {
    let socket: WebSocketLike;
    let settled = false;
    const timeout = setTimeout(() => fail(new Error(`Codex WebSocket connect timed out after ${CONNECT_TIMEOUT_MS}ms`)), CONNECT_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timeout);
      socket?.removeEventListener("open", onOpen);
      socket?.removeEventListener("error", onError);
      socket?.removeEventListener("close", onClose);
      signal?.removeEventListener("abort", onAbort);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      try { socket?.close(); } catch {}
      reject(error);
    };
    const onOpen: WebSocketListener = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(socket);
    };
    const onError: WebSocketListener = (event) => fail(webSocketEventError(event));
    const onClose: WebSocketListener = (event) => fail(webSocketCloseError(event));
    const onAbort = () => fail(new Error("Request was aborted"));

    try {
      socket = new WebSocketCtor(url, { headers: headerRecord });
      socket.addEventListener("open", onOpen);
      socket.addEventListener("error", onError);
      socket.addEventListener("close", onClose);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function headerIdentity(headers: Headers): string {
  const entries = [...headers.entries()].sort(([left], [right]) => left.localeCompare(right));
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

function isOpen(socket: WebSocketLike): boolean {
  return socket.readyState === undefined || socket.readyState === 1;
}

function closeSocket(socket: WebSocketLike, code = 1000, reason = "done"): void {
  try { socket.close(code, reason); } catch {}
}

function toWebSocketUrl(endpoint: string): string {
  const url = new URL(endpoint);
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  return url.toString();
}

async function webSocketDataToString(data: unknown): Promise<string | undefined> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  if (data && typeof data === "object" && "arrayBuffer" in data) {
    const arrayBuffer = await (data as { arrayBuffer(): Promise<ArrayBuffer> }).arrayBuffer();
    return new TextDecoder().decode(new Uint8Array(arrayBuffer));
  }
  return undefined;
}

function isTerminalEvent(data: string): boolean {
  try {
    const event = JSON.parse(data) as { type?: unknown };
    return event.type === "response.completed"
      || event.type === "response.done"
      || event.type === "response.incomplete"
      || event.type === "response.failed"
      || event.type === "error";
  } catch {
    return false;
  }
}

function webSocketEventError(event: unknown): Error {
  if (event && typeof event === "object") {
    const nested = "error" in event ? (event as { error?: unknown }).error : undefined;
    if (nested instanceof Error) return nested;
    const message = "message" in event ? (event as { message?: unknown }).message : undefined;
    if (typeof message === "string" && message) return new Error(message);
  }
  return new Error("Codex WebSocket error");
}

function webSocketCloseError(event: unknown): Error {
  if (event && typeof event === "object") {
    const code = "code" in event ? (event as { code?: unknown }).code : undefined;
    const reason = "reason" in event ? (event as { reason?: unknown }).reason : undefined;
    return new Error(`Codex WebSocket closed${typeof code === "number" ? ` ${code}` : ""}${typeof reason === "string" && reason ? `: ${reason}` : ""}`);
  }
  return new Error("Codex WebSocket closed");
}
