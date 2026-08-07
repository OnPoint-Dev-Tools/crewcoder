import crypto from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { URL } from "node:url";
import { readConfig } from "./config.js";
import type { AgentEvent, AgentEventSink } from "./events.js";
import { createExtensionUiBridge, type ExtensionUiBridge } from "./extension-ui-bridge.js";
import { runAgentLoop, type AgentLoopResult } from "./agent-loop.js";
import { runAgentLoopContinue } from "./agent-loop-continue.js";
import { createBackendDebugLogger } from "./backend-debug-logger.js";
import { ProviderModelClient } from "../providers/provider-model-client.js";
import { resolveModel } from "../providers/model-registry.js";
import type { ApprovalMode } from "./approval.js";
import type { AgentMode } from "./types.js";
import { isAgentMode, DEFAULT_AGENT_MODE } from "./mode-router.js";
import { FleetRunStore, FLEET_RUN_STORE_VERSION, type FleetRunMetadata } from "./fleet-store.js";
import { FLEET_PROTOCOL_VERSION, type FleetEvent, type FleetEventRecord, type FleetProtocolEvent, type FleetRunRequest, type FleetRunStatus, type FleetRunSummary } from "./fleet-types.js";
import type { ApprovalControlDecision, UiControlResponse } from "./stdin-control.js";
import { FLEET_WEBSOCKET_PROTOCOL, getOrCreateFleetToken, isFleetRequestAuthorized, isFleetWebSocketAuthorized, requestedFleetWebSocketProtocol, validateFleetToken } from "./fleet-auth.js";

export { FLEET_PROTOCOL_VERSION } from "./fleet-types.js";
export type { FleetEvent, FleetEventRecord, FleetProtocolEvent, FleetRunRequest, FleetRunStatus, FleetRunSummary } from "./fleet-types.js";

export type FleetServerOptions = {
  host?: string;
  port?: number;
  cwd?: string;
  /** Explicit token for tests/embedded hosts. Defaults to the persistent fleet token. */
  authToken?: string;
  /** Persist run metadata and events. Defaults to true. */
  persistRuns?: boolean;
  /** Override the durable run store directory. */
  runStoreDir?: string;
};

export type FleetServerHandle = {
  server: http.Server;
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
};

type Subscriber = {
  send(record: FleetEventRecord): void;
  close(): void;
};

type FleetRunState = {
  runId: string;
  request: FleetRunRequest;
  status: FleetRunStatus;
  createdAt: string;
  updatedAt: string;
  events: FleetEventRecord[];
  lastEventId: number;
  store?: FleetRunStore;
  subscribers: Set<Subscriber>;
  abortController: AbortController;
  manualCompactSignal: { requested: boolean };
  followUpSignal: { messages: string[] };
  approvalSignal: { decisions: ApprovalControlDecision[] };
  uiBridge: ExtensionUiBridge;
  result?: AgentLoopResult;
  sessionId?: string;
  error?: string;
};

export async function startFleetServer(options: FleetServerOptions = {}): Promise<FleetServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 8787;
  const cwd = options.cwd ?? process.cwd();
  const authToken = validateFleetToken(options.authToken ?? getOrCreateFleetToken());
  const store = options.persistRuns === false ? undefined : new FleetRunStore(options.runStoreDir);
  const runs = restoreFleetRuns(store);

  const server = http.createServer((req, res) => {
    void handleHttpRequest(req, res, { runs, cwd, authToken, store });
  });
  server.on("upgrade", (req, socket) => {
    handleWebSocketUpgrade(req, socket, { runs, authToken });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fleet server did not bind to a TCP port.");
  const port = address.port;
  return {
    server,
    host,
    port,
    url: `http://${host}:${port}`,
    close: () => new Promise((resolve, reject) => {
      for (const run of runs.values()) run.abortController.abort();
      server.close((error) => error ? reject(error) : resolve());
    })
  };
}

async function handleHttpRequest(req: IncomingMessage, res: ServerResponse, context: { runs: Map<string, FleetRunState>; cwd: string; authToken: string; store?: FleetRunStore }): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/health") {
    writeJson(res, 200, { ok: true, service: "crewcoder-fleet", authentication: "bearer", protocolVersion: FLEET_PROTOCOL_VERSION, durability: context.store ? "persistent" : "memory" });
    return;
  }
  if (!isFleetRequestAuthorized(req, context.authToken)) {
    writeUnauthorized(res);
    return;
  }
  if (req.method === "GET" && url.pathname === "/runs") {
    const summaries = [...context.runs.values()]
      .map(summarizeRun)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    writeJson(res, 200, summaries);
    return;
  }
  if (req.method === "POST" && url.pathname === "/runs") {
    try {
      const body = await readJsonBody(req);
      const state = await createFleetRun(normalizeRunRequest(body, context.cwd), context.runs, context.cwd, context.store);
      writeJson(res, 202, { runId: state.runId, status: state.status, eventUrl: `/runs/${state.runId}/events`, wsUrl: `/runs/${state.runId}/ws` });
    } catch (error) {
      writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  const runMatch = url.pathname.match(/^\/runs\/([^/]+)$/);
  if (req.method === "GET" && runMatch?.[1]) {
    const run = context.runs.get(runMatch[1]);
    if (!run) { writeJson(res, 404, { error: "Run not found" }); return; }
    writeJson(res, 200, summarizeRun(run));
    return;
  }
  const eventsMatch = url.pathname.match(/^\/runs\/([^/]+)\/events$/);
  if (req.method === "GET" && eventsMatch?.[1]) {
    const run = context.runs.get(eventsMatch[1]);
    if (!run) { writeJson(res, 404, { error: "Run not found" }); return; }
    attachSseSubscriber(run, res, url.searchParams.get("replay") === "1", readAfterEventId(req, url));
    return;
  }
  const controlMatch = url.pathname.match(/^\/runs\/([^/]+)\/control$/);
  if (req.method === "POST" && controlMatch?.[1]) {
    const run = context.runs.get(controlMatch[1]);
    if (!run) { writeJson(res, 404, { error: "Run not found" }); return; }
    const body = await readJsonBody(req);
    const applied = applyControlMessage(run, body);
    writeJson(res, applied ? 202 : 400, { ok: applied });
    return;
  }
  writeJson(res, 404, { error: "Not found" });
}

async function createFleetRun(request: FleetRunRequest, runs: Map<string, FleetRunState>, cwd: string, store?: FleetRunStore): Promise<FleetRunState> {
  const runId = `run_${new Date().toISOString().replace(/[:.]/g, "-")}_${Math.random().toString(36).slice(2, 8)}`;
  const abortController = new AbortController();
  const manualCompactSignal = { requested: false };
  const followUpSignal: { messages: string[] } = { messages: [] };
  const approvalSignal: { decisions: ApprovalControlDecision[] } = { decisions: [] };
  let state: FleetRunState;
  const emit: AgentEventSink = async (event) => dispatchEvent(state, event);
  const uiBridge = createExtensionUiBridge({ emit, hasUI: true, signal: abortController.signal });
  state = {
    runId,
    request,
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    events: [],
    lastEventId: 0,
    store,
    subscribers: new Set(),
    abortController,
    manualCompactSignal,
    followUpSignal,
    approvalSignal,
    uiBridge
  };
  runs.set(runId, state);
  persistRunMetadata(state);
  dispatchEvent(state, { type: "fleet_run_created", runId, status: "running" });
  void runFleetLoop(state, cwd);
  return state;
}

async function runFleetLoop(state: FleetRunState, fallbackCwd: string): Promise<void> {
  const config = readConfig();
  const providerId = state.request.provider ?? process.env.CREWCODER_PROVIDER ?? config.defaultProvider;
  const model = state.request.model ?? process.env.CREWCODER_MODEL ?? config.defaultModel;
  const cwd = state.request.cwd ?? fallbackCwd;
  const debug = createBackendDebugLogger({ emit: async (event) => dispatchEvent(state, event), runId: `fleet-${state.runId}` });
  try {
    const contextWindow = (await resolveModel(providerId, model))?.metadata?.contextWindow;
    const common = {
      providerId,
      model,
      contextWindow,
      maxIterations: state.request.maxIterations ?? config.maxIterations,
      approvalMode: state.request.approval ?? "never",
      modelClient: state.request.heuristic ? undefined : new ProviderModelClient(providerId, cwd, model, debug, state.request.effort),
      systemPromptName: state.request.systemPrompt,
      workerName: state.request.worker,
      manualCompactSignal: state.manualCompactSignal,
      followUpSignal: state.followUpSignal,
      approvalSignal: state.approvalSignal,
      uiBridge: state.uiBridge,
      signal: state.abortController.signal,
      emit: async (event: AgentEvent) => dispatchEvent(state, event)
    };
    state.result = state.request.sessionId
      ? await runAgentLoopContinue({ sessionId: state.request.sessionId, prompt: state.request.prompt, mode: state.request.mode ?? DEFAULT_AGENT_MODE, cwd }, common)
      : await runAgentLoop({ prompt: requiredPrompt(state.request.prompt), requestedMode: state.request.mode ?? config.defaultMode, cwd }, common);
    state.status = state.abortController.signal.aborted ? "aborted" : "completed";
    state.sessionId = state.result.sessionId;
    dispatchEvent(state, { type: "fleet_run_status", runId: state.runId, status: state.status, sessionId: state.sessionId });
  } catch (error) {
    state.status = state.abortController.signal.aborted ? "aborted" : "failed";
    state.error = error instanceof Error ? error.message : String(error);
    dispatchEvent(state, { type: "fleet_run_status", runId: state.runId, status: state.status, error: state.error });
  } finally {
    state.updatedAt = new Date().toISOString();
    state.uiBridge.cancelAll();
    persistRunMetadata(state);
    for (const subscriber of state.subscribers) subscriber.close();
    state.subscribers.clear();
  }
}

function dispatchEvent(state: FleetRunState, event: FleetEvent): void {
  const record: FleetEventRecord = {
    id: state.lastEventId + 1,
    emittedAt: new Date().toISOString(),
    event
  };
  state.lastEventId = record.id;
  state.events.push(record);
  state.updatedAt = record.emittedAt;
  state.store?.appendEvent(state.runId, record);
  persistRunMetadata(state);
  for (const subscriber of state.subscribers) subscriber.send(record);
}

function attachSseSubscriber(run: FleetRunState, res: ServerResponse, replayOnly = false, afterEventId = 0): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });
  const subscriber: Subscriber = {
    send(record) {
      res.write(`id: ${record.id}\ndata: ${JSON.stringify({ ...record.event, fleetEventId: record.id, emittedAt: record.emittedAt })}\n\n`);
    },
    close() { res.end(); }
  };
  run.subscribers.add(subscriber);
  for (const record of run.events) {
    if (record.id > afterEventId) subscriber.send(record);
  }
  if (replayOnly || run.status !== "running") {
    run.subscribers.delete(subscriber);
    subscriber.close();
    return;
  }
  res.on("close", () => run.subscribers.delete(subscriber));
}

function handleWebSocketUpgrade(req: IncomingMessage, socket: Duplex, context: { runs: Map<string, FleetRunState>; authToken: string }): void {
  if (!isFleetWebSocketAuthorized(req, context.authToken)) {
    socket.end("HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Bearer realm=\"crewcoder-fleet\"\r\nConnection: close\r\n\r\n");
    return;
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  const match = url.pathname.match(/^\/runs\/([^/]+)\/ws$/);
  const key = req.headers["sec-websocket-key"];
  if (!match?.[1] || typeof key !== "string") {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return;
  }
  const run = context.runs.get(match[1]);
  if (!run) {
    socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
    return;
  }
  const accept = crypto.createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    ...(requestedFleetWebSocketProtocol(req) ? [`Sec-WebSocket-Protocol: ${FLEET_WEBSOCKET_PROTOCOL}`] : []),
    "",
    ""
  ].join("\r\n"));
  const afterEventId = readAfterEventId(req, url);
  const subscriber: Subscriber = {
    send(record) { writeWebSocketText(socket, JSON.stringify({ ...record.event, fleetEventId: record.id, emittedAt: record.emittedAt })); },
    close() { socket.end(); }
  };
  run.subscribers.add(subscriber);
  for (const record of run.events) {
    if (record.id > afterEventId) subscriber.send(record);
  }
  if (run.status !== "running") {
    run.subscribers.delete(subscriber);
    subscriber.close();
    return;
  }
  socket.on("data", (chunk) => {
    for (const text of readWebSocketTextFrames(chunk)) {
      try { applyControlMessage(run, JSON.parse(text) as unknown); } catch {}
    }
  });
  socket.on("close", () => run.subscribers.delete(subscriber));
  socket.on("error", () => run.subscribers.delete(subscriber));
}

function applyControlMessage(run: FleetRunState, value: unknown): boolean {
  if (run.status !== "running" || !value || typeof value !== "object") return false;
  const msg = value as Record<string, unknown>;
  if (msg.type !== "control") return false;
  if (msg.action === "compact") { run.manualCompactSignal.requested = true; return true; }
  if (msg.action === "follow_up" && typeof msg.message === "string" && msg.message.trim()) {
    run.followUpSignal.messages.push(msg.message.trim());
    return true;
  }
  if (msg.action === "approval" && typeof msg.approvalId === "string" && typeof msg.approved === "boolean") {
    run.approvalSignal.decisions.push({ approvalId: msg.approvalId, approved: msg.approved, reason: typeof msg.reason === "string" ? msg.reason : undefined });
    return true;
  }
  if (msg.action === "ui_response" && typeof msg.requestId === "string") {
    const response: UiControlResponse = { requestId: msg.requestId, value: typeof msg.value === "string" || typeof msg.value === "boolean" || msg.value === null ? msg.value : null };
    return run.uiBridge.resolveResponse(response.requestId, response.value);
  }
  if (msg.action === "abort") { run.abortController.abort(); return true; }
  return false;
}

function restoreFleetRuns(store: FleetRunStore | undefined): Map<string, FleetRunState> {
  const runs = new Map<string, FleetRunState>();
  if (!store) return runs;
  for (const stored of store.loadRuns()) {
    const abortController = new AbortController();
    const manualCompactSignal = { requested: false };
    const followUpSignal: { messages: string[] } = { messages: [] };
    const approvalSignal: { decisions: ApprovalControlDecision[] } = { decisions: [] };
    let state: FleetRunState;
    const emit: AgentEventSink = async (event) => dispatchEvent(state, event);
    const uiBridge = createExtensionUiBridge({ emit, hasUI: true, signal: abortController.signal });
    const lastEventId = stored.events.reduce((maximum, record) => Math.max(maximum, record.id), 0);
    state = {
      runId: stored.metadata.runId,
      request: stored.metadata.request,
      status: stored.metadata.status,
      createdAt: stored.metadata.createdAt,
      updatedAt: stored.metadata.updatedAt,
      events: stored.events,
      lastEventId,
      store,
      subscribers: new Set(),
      abortController,
      manualCompactSignal,
      followUpSignal,
      approvalSignal,
      uiBridge,
      sessionId: stored.metadata.sessionId,
      error: stored.metadata.error
    };
    runs.set(state.runId, state);
    if (state.status === "running") {
      state.status = "failed";
      state.error = "Fleet run interrupted by server restart.";
      dispatchEvent(state, {
        type: "fleet_run_status",
        runId: state.runId,
        status: "failed",
        sessionId: state.sessionId,
        error: state.error,
        interrupted: true
      });
      state.uiBridge.cancelAll();
    } else {
      persistRunMetadata(state);
    }
  }
  return runs;
}

function persistRunMetadata(run: FleetRunState): void {
  if (!run.store) return;
  const metadata: FleetRunMetadata = {
    version: FLEET_RUN_STORE_VERSION,
    runId: run.runId,
    request: run.request,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    eventCount: run.events.length,
    lastEventId: run.lastEventId,
    ...(run.sessionId ? { sessionId: run.sessionId } : {}),
    ...(run.error ? { error: run.error } : {})
  };
  run.store.writeMetadata(metadata);
}

function readAfterEventId(req: IncomingMessage, url: URL): number {
  const query = url.searchParams.get("after");
  const header = req.headers["last-event-id"];
  const value = query ?? (Array.isArray(header) ? header[0] : header);
  if (!value) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function summarizeRun(run: FleetRunState): FleetRunSummary {
  return {
    runId: run.runId,
    status: run.status,
    sessionId: run.sessionId,
    error: run.error,
    eventCount: run.events.length,
    lastEventId: run.lastEventId,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt
  };
}

function normalizeRunRequest(value: unknown, cwd: string): FleetRunRequest {
  if (!value || typeof value !== "object") throw new Error("Expected JSON object body.");
  const obj = value as Record<string, unknown>;
  return {
    prompt: typeof obj.prompt === "string" ? obj.prompt : undefined,
    sessionId: typeof obj.sessionId === "string" ? obj.sessionId : undefined,
    mode: isAgentModeValue(obj.mode) ? obj.mode : undefined,
    provider: typeof obj.provider === "string" ? obj.provider : undefined,
    model: typeof obj.model === "string" ? obj.model : undefined,
    worker: typeof obj.worker === "string" ? obj.worker : undefined,
    systemPrompt: typeof obj.systemPrompt === "string" ? obj.systemPrompt : undefined,
    effort: typeof obj.effort === "string" ? obj.effort : undefined,
    cwd: typeof obj.cwd === "string" && obj.cwd.trim() ? obj.cwd : cwd,
    approval: isApprovalMode(obj.approval) ? obj.approval : undefined,
    maxIterations: typeof obj.maxIterations === "number" && Number.isInteger(obj.maxIterations) ? Math.min(Math.max(obj.maxIterations, 1), 50) : undefined,
    heuristic: obj.heuristic === true
  };
}

function requiredPrompt(prompt: string | undefined): string {
  const trimmed = prompt?.trim();
  if (!trimmed) throw new Error("Run requests require prompt unless sessionId is provided.");
  return trimmed;
}

function isAgentModeValue(value: unknown): value is AgentMode {
  return typeof value === "string" && isAgentMode(value);
}

function isApprovalMode(value: unknown): value is ApprovalMode {
  return value === "never" || value === "review" || value === "always" || value === "full-access" || value === "sandboxed";
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
      if (body.length > 1_000_000) {
        req.destroy();
        reject(new Error("Request body too large."));
      }
    });
    req.on("end", () => {
      if (!body.trim()) { resolve({}); return; }
      try { resolve(JSON.parse(body) as unknown); } catch (error) { reject(error); }
    });
    req.on("error", reject);
  });
}

function writeJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value, null, 2));
}

function writeUnauthorized(res: ServerResponse): void {
  res.writeHead(401, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "WWW-Authenticate": "Bearer realm=\"crewcoder-fleet\""
  });
  res.end(JSON.stringify({ error: "Unauthorized" }));
}

function writeWebSocketText(socket: Duplex, text: string): void {
  const payload = Buffer.from(text, "utf8");
  if (payload.length > 65_535) return;
  const header = payload.length < 126 ? Buffer.from([0x81, payload.length]) : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]);
  socket.write(Buffer.concat([header, payload]));
}

function readWebSocketTextFrames(buffer: Buffer): string[] {
  const frames: string[] = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset]!;
    const second = buffer[offset + 1]!;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    offset += 2;
    if (length === 126) {
      if (offset + 2 > buffer.length) break;
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      break;
    }
    let mask: Buffer | undefined;
    if (masked) {
      if (offset + 4 > buffer.length) break;
      mask = buffer.subarray(offset, offset + 4);
      offset += 4;
    }
    if (offset + length > buffer.length) break;
    const payload = Buffer.from(buffer.subarray(offset, offset + length));
    offset += length;
    if (mask) {
      for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i % 4]!;
    }
    if (opcode === 0x1) frames.push(payload.toString("utf8"));
  }
  return frames;
}
