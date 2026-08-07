import { CrewCoderError, CrewCoderFleetProtocolError, CrewCoderFleetRequestError } from "./errors.js";

export type CrewCoderAgentMode = "general" | "plugin" | "extension";
export type CrewCoderApprovalMode = "never" | "review" | "always" | "full-access" | "sandboxed";
/** Browser-safe structural event type. Narrow by `type` and validate fields used by your UI. */
export type CrewCoderRemoteAgentEvent = { type: string; [key: string]: unknown };

export const CREWCODER_FLEET_PROTOCOL_VERSION = "1.0" as const;

export type CrewCoderFleetRunRequest = {
  prompt?: string;
  sessionId?: string;
  mode?: CrewCoderAgentMode;
  provider?: string;
  model?: string;
  worker?: string;
  systemPrompt?: string;
  effort?: string;
  cwd?: string;
  approval?: CrewCoderApprovalMode;
  maxIterations?: number;
  heuristic?: boolean;
};

export type CrewCoderFleetRunStatus = "running" | "completed" | "failed" | "aborted";

export type CrewCoderFleetRunSummary = {
  runId: string;
  status: CrewCoderFleetRunStatus;
  sessionId?: string;
  error?: string;
  eventCount: number;
  lastEventId: number;
  createdAt: string;
  updatedAt: string;
};

export type CrewCoderFleetRunCreated = {
  runId: string;
  status: CrewCoderFleetRunStatus;
  eventUrl: string;
  wsUrl: string;
};

export type CrewCoderFleetProtocolEvent =
  | { type: "fleet_run_created"; runId: string; status: CrewCoderFleetRunStatus }
  | { type: "fleet_run_status"; runId: string; status: CrewCoderFleetRunStatus; sessionId?: string; error?: string; interrupted?: boolean };

export type CrewCoderFleetEvent = (CrewCoderRemoteAgentEvent | CrewCoderFleetProtocolEvent) & {
  fleetEventId?: number;
  emittedAt?: string;
};

export type CrewCoderFleetControl =
  | { type: "control"; action: "compact" }
  | { type: "control"; action: "follow_up"; message: string }
  | { type: "control"; action: "approval"; approvalId: string; approved: boolean; reason?: string }
  | { type: "control"; action: "ui_response"; requestId: string; value: string | boolean | null }
  | { type: "control"; action: "abort" };

export type CrewCoderFleetHealth = {
  ok: boolean;
  service: string;
  authentication: string;
  protocolVersion: string;
  durability: "persistent" | "memory";
};

export type CrewCoderFleetReconnectOptions = {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
};

export type CrewCoderFleetClientOptions = {
  baseUrl: string;
  token: string;
  fetch?: typeof globalThis.fetch;
  reconnect?: false | CrewCoderFleetReconnectOptions;
};

export type CrewCoderFleetEventStreamOptions = {
  replay?: boolean;
  signal?: AbortSignal;
  afterEventId?: number;
  reconnect?: false | CrewCoderFleetReconnectOptions;
  onReconnect?(attempt: number, afterEventId: number): Promise<void> | void;
};

export type CrewCoderFleetWaitOptions = {
  signal?: AbortSignal;
  pollIntervalMs?: number;
  timeoutMs?: number;
};

type ReconnectPolicy = {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
};

type StreamChunkResult = {
  buffer: string;
  lastEventId: number;
  terminal: boolean;
};

class FleetListenerError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super("Fleet event listener failed.");
    this.cause = cause;
  }
}

export class CrewCoderClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly reconnect: false | CrewCoderFleetReconnectOptions;

  constructor(options: CrewCoderFleetClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.token = validateClientToken(options.token);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.reconnect = options.reconnect ?? {};
  }

  async health(): Promise<CrewCoderFleetHealth> {
    const response = await this.fetchImpl(`${this.baseUrl}/health`);
    const value = await readJsonResponse(response);
    if (!isRecord(value) || typeof value.ok !== "boolean" || typeof value.service !== "string" || typeof value.authentication !== "string" || typeof value.protocolVersion !== "string" || (value.durability !== "persistent" && value.durability !== "memory")) {
      throw new CrewCoderFleetProtocolError("Fleet health response is invalid.");
    }
    return {
      ok: value.ok,
      service: value.service,
      authentication: value.authentication,
      protocolVersion: value.protocolVersion,
      durability: value.durability
    };
  }

  async createRun(request: CrewCoderFleetRunRequest): Promise<CrewCoderFleetRunCreated> {
    const value = await this.authenticatedJson("/runs", { method: "POST", body: JSON.stringify(request) });
    if (!isRecord(value) || typeof value.runId !== "string" || !isRunStatus(value.status) || typeof value.eventUrl !== "string" || typeof value.wsUrl !== "string") {
      throw new CrewCoderFleetProtocolError("Fleet run creation response is invalid.");
    }
    return { runId: value.runId, status: value.status, eventUrl: value.eventUrl, wsUrl: value.wsUrl };
  }

  async listRuns(): Promise<CrewCoderFleetRunSummary[]> {
    const value = await this.authenticatedJson("/runs");
    if (!Array.isArray(value)) throw new CrewCoderFleetProtocolError("Fleet run list response is invalid.");
    return value.map((entry) => parseRunSummary(entry));
  }

  async getRun(runId: string): Promise<CrewCoderFleetRunSummary> {
    const value = await this.authenticatedJson(`/runs/${encodeURIComponent(requiredId(runId, "runId"))}`);
    return parseRunSummary(value);
  }

  async waitForRun(runId: string, options: CrewCoderFleetWaitOptions = {}): Promise<CrewCoderFleetRunSummary> {
    const pollIntervalMs = positiveInteger(options.pollIntervalMs ?? 250, "pollIntervalMs");
    const timeoutMs = options.timeoutMs === undefined ? 0 : positiveInteger(options.timeoutMs, "timeoutMs");
    const startedAt = Date.now();
    while (true) {
      throwIfAborted(options.signal);
      const summary = await this.getRun(runId);
      if (summary.status !== "running") return summary;
      if (timeoutMs && Date.now() - startedAt >= timeoutMs) {
        throw new CrewCoderError("STREAM_DISCONNECTED", `Timed out waiting for fleet run ${runId}.`);
      }
      await wait(Math.min(pollIntervalMs, timeoutMs ? Math.max(1, timeoutMs - (Date.now() - startedAt)) : pollIntervalMs), options.signal);
    }
  }

  async control(runId: string, control: CrewCoderFleetControl): Promise<boolean> {
    const value = await this.authenticatedJson(`/runs/${encodeURIComponent(requiredId(runId, "runId"))}/control`, {
      method: "POST",
      body: JSON.stringify(control)
    });
    if (!isRecord(value) || typeof value.ok !== "boolean") throw new CrewCoderFleetProtocolError("Fleet control response is invalid.");
    return value.ok;
  }

  async streamEvents(
    runId: string,
    listener: (event: CrewCoderFleetEvent) => Promise<void> | void,
    options: CrewCoderFleetEventStreamOptions = {}
  ): Promise<void> {
    const id = encodeURIComponent(requiredId(runId, "runId"));
    let afterEventId = nonNegativeInteger(options.afterEventId ?? 0, "afterEventId");
    const reconnect = options.replay ? false : normalizeReconnect(options.reconnect ?? this.reconnect);
    let reconnectAttempt = 0;

    while (true) {
      throwIfAborted(options.signal);
      try {
        const result = await this.consumeEventStream(id, afterEventId, listener, options);
        afterEventId = result.lastEventId;
        if (options.replay || result.terminal) return;
        throw new CrewCoderError("STREAM_DISCONNECTED", "Fleet event stream ended before a terminal run status.");
      } catch (error) {
        if (error instanceof FleetListenerError) throw error.cause;
        if (options.signal?.aborted) throw abortedError(options.signal.reason);
        if (!shouldReconnect(error, reconnect, reconnectAttempt)) throw normalizeStreamError(error);
        reconnectAttempt += 1;
        await options.onReconnect?.(reconnectAttempt, afterEventId);
        const delay = Math.min(reconnect.maxDelayMs, reconnect.initialDelayMs * 2 ** (reconnectAttempt - 1));
        await wait(delay, options.signal);
      }
    }
  }

  webSocketConnection(runId: string, afterEventId = 0): { url: string; protocols: string[] } {
    const url = new URL(`/runs/${encodeURIComponent(requiredId(runId, "runId"))}/ws`, this.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const cursor = nonNegativeInteger(afterEventId, "afterEventId");
    if (cursor) url.searchParams.set("after", String(cursor));
    return {
      url: url.toString(),
      protocols: ["crewcoder.v1", `crewcoder.auth.${this.token}`]
    };
  }

  private async consumeEventStream(
    runId: string,
    afterEventId: number,
    listener: (event: CrewCoderFleetEvent) => Promise<void> | void,
    options: CrewCoderFleetEventStreamOptions
  ): Promise<{ lastEventId: number; terminal: boolean }> {
    const search = new URLSearchParams();
    if (options.replay) search.set("replay", "1");
    if (afterEventId) search.set("after", String(afterEventId));
    const suffix = search.size ? `?${search.toString()}` : "";
    const headers = this.authHeaders();
    if (afterEventId) headers.set("last-event-id", String(afterEventId));
    const response = await this.fetchImpl(`${this.baseUrl}/runs/${runId}/events${suffix}`, {
      headers,
      signal: options.signal
    });
    await ensureSuccessful(response);
    if (!response.body) throw new CrewCoderFleetProtocolError("Fleet event stream returned no body.");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let state: StreamChunkResult = { buffer: "", lastEventId: afterEventId, terminal: false };
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        state.buffer += decoder.decode(chunk.value, { stream: true }).replaceAll("\r\n", "\n");
        state = await drainSseRecords(state, listener);
      }
      state.buffer += decoder.decode().replaceAll("\r\n", "\n");
      state = await drainSseRecords({ ...state, buffer: `${state.buffer}\n\n` }, listener);
      return { lastEventId: state.lastEventId, terminal: state.terminal };
    } finally {
      reader.releaseLock();
    }
  }

  private async authenticatedJson(pathname: string, init: RequestInit = {}): Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.token}`);
    if (init.body !== undefined) headers.set("content-type", "application/json");
    const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, { ...init, headers });
    return readJsonResponse(response);
  }

  private authHeaders(): Headers {
    return new Headers({ authorization: `Bearer ${this.token}` });
  }
}

async function readJsonResponse(response: Response): Promise<unknown> {
  await ensureSuccessful(response);
  try {
    return await response.json() as unknown;
  } catch (error) {
    throw new CrewCoderFleetProtocolError("Fleet response did not contain valid JSON.", { cause: error });
  }
}

async function ensureSuccessful(response: Response): Promise<void> {
  if (response.ok) return;
  const body = await response.text().catch(() => "");
  throw new CrewCoderFleetRequestError(response.status, body, response.statusText);
}

async function drainSseRecords(
  input: StreamChunkResult,
  listener: (event: CrewCoderFleetEvent) => Promise<void> | void
): Promise<StreamChunkResult> {
  let { buffer, lastEventId, terminal } = input;
  let boundary = buffer.indexOf("\n\n");
  while (boundary >= 0) {
    const record = buffer.slice(0, boundary);
    buffer = buffer.slice(boundary + 2);
    const lines = record.split("\n");
    const idLine = lines.find((line) => line.startsWith("id:"));
    const parsedId = idLine ? Number(idLine.slice(3).trim()) : undefined;
    const data = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data) {
      let parsed: unknown;
      try { parsed = JSON.parse(data) as unknown; }
      catch (error) { throw new CrewCoderFleetProtocolError("Fleet event stream emitted invalid JSON.", { cause: error }); }
      if (!isRecord(parsed) || typeof parsed.type !== "string") throw new CrewCoderFleetProtocolError("Fleet event stream emitted an invalid event.");
      const eventId = Number.isSafeInteger(parsedId) && (parsedId as number) > 0
        ? parsedId as number
        : Number.isSafeInteger(parsed.fleetEventId) && (parsed.fleetEventId as number) > 0
          ? parsed.fleetEventId as number
          : undefined;
      if (eventId !== undefined) {
        lastEventId = Math.max(lastEventId, eventId);
        parsed.fleetEventId = eventId;
      }
      const event = parsed as CrewCoderFleetEvent;
      terminal ||= event.type === "fleet_run_status" && event.status !== "running";
      try { await listener(event); }
      catch (error) { throw new FleetListenerError(error); }
    }
    boundary = buffer.indexOf("\n\n");
  }
  return { buffer, lastEventId, terminal };
}

function parseRunSummary(value: unknown): CrewCoderFleetRunSummary {
  if (!isRecord(value) || typeof value.runId !== "string" || !isRunStatus(value.status) || typeof value.eventCount !== "number" || typeof value.lastEventId !== "number" || typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") {
    throw new CrewCoderFleetProtocolError("Fleet run summary response is invalid.");
  }
  return {
    runId: value.runId,
    status: value.status,
    eventCount: value.eventCount,
    lastEventId: value.lastEventId,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(typeof value.sessionId === "string" ? { sessionId: value.sessionId } : {}),
    ...(typeof value.error === "string" ? { error: value.error } : {})
  };
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch (error) { throw new CrewCoderError("INVALID_ARGUMENT", "Fleet baseUrl must be a valid URL.", { cause: error }); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new CrewCoderError("INVALID_ARGUMENT", "Fleet baseUrl must use http or https.");
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function validateClientToken(value: string): string {
  const token = value.trim();
  if (token.length < 32 || !/^[A-Za-z0-9_-]+$/.test(token)) throw new CrewCoderError("INVALID_ARGUMENT", "Fleet token must be at least 32 URL-safe characters.");
  return token;
}

function requiredId(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new CrewCoderError("INVALID_ARGUMENT", `${label} is required.`);
  return normalized;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new CrewCoderError("INVALID_ARGUMENT", `${label} must be a non-negative integer.`);
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new CrewCoderError("INVALID_ARGUMENT", `${label} must be a positive integer.`);
  return value;
}

function normalizeReconnect(value: false | CrewCoderFleetReconnectOptions): false | ReconnectPolicy {
  if (value === false) return false;
  const maxAttempts = nonNegativeInteger(value.maxAttempts ?? 3, "reconnect.maxAttempts");
  const initialDelayMs = positiveInteger(value.initialDelayMs ?? 250, "reconnect.initialDelayMs");
  const maxDelayMs = positiveInteger(value.maxDelayMs ?? 4_000, "reconnect.maxDelayMs");
  if (maxDelayMs < initialDelayMs) throw new CrewCoderError("INVALID_ARGUMENT", "reconnect.maxDelayMs must be greater than or equal to reconnect.initialDelayMs.");
  return { maxAttempts, initialDelayMs, maxDelayMs };
}

function shouldReconnect(error: unknown, policy: false | ReconnectPolicy, attempts: number): policy is ReconnectPolicy {
  if (!policy || attempts >= policy.maxAttempts) return false;
  if (error instanceof CrewCoderFleetProtocolError) return false;
  if (error instanceof CrewCoderFleetRequestError) return error.retryable;
  return true;
}

function normalizeStreamError(error: unknown): unknown {
  if (error instanceof CrewCoderError) {
    if (error.code === "STREAM_DISCONNECTED") return new CrewCoderError("RECONNECT_EXHAUSTED", "Fleet event stream disconnected and reconnect attempts were exhausted.", { cause: error });
    return error;
  }
  return new CrewCoderError("RECONNECT_EXHAUSTED", "Fleet event stream failed and reconnect attempts were exhausted.", { cause: error });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortedError(signal.reason);
}

function abortedError(reason: unknown): CrewCoderError {
  return new CrewCoderError("ABORTED", "CrewCoder operation was aborted.", { cause: reason });
}

function wait(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortedError(signal?.reason));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isRunStatus(value: unknown): value is CrewCoderFleetRunStatus {
  return value === "running" || value === "completed" || value === "failed" || value === "aborted";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Backward-compatible name retained for users migrating from crewcoder-sdk. */
export { CrewCoderClient as CrewCoderFleetClient };
