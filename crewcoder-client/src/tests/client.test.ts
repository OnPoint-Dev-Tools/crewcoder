import { describe, expect, it } from "vitest";
import {
  CREWCODER_FLEET_PROTOCOL_VERSION,
  CrewCoderClient,
  CrewCoderError,
  CrewCoderFleetClient,
  CrewCoderFleetProtocolError,
  CrewCoderFleetRequestError
} from "../index.js";

const token = "test_fleet_token_1234567890_abcdefghijklmno";

describe("CrewCoderClient", () => {
  it("retains CrewCoderFleetClient as the same compatibility class", () => {
    expect(CrewCoderFleetClient).toBe(CrewCoderClient);
  });

  it("authenticates run, status, control, and SSE requests", async () => {
    const requests: Array<{ url: string; authorization: string | null; method: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      requests.push({
        url,
        authorization: new Headers(init?.headers).get("authorization"),
        method: init?.method ?? "GET"
      });
      if (url.endsWith("/health")) return Response.json({ ok: true, service: "crewcoder-fleet", authentication: "bearer", protocolVersion: "1.0", durability: "persistent" });
      if (url.endsWith("/runs") && init?.method === "POST") {
        return Response.json({ runId: "run_1", status: "running", eventUrl: "/runs/run_1/events", wsUrl: "/runs/run_1/ws" }, { status: 202 });
      }
      if (url.endsWith("/runs/run_1/control")) return Response.json({ ok: true }, { status: 202 });
      if (url.endsWith("/runs")) return Response.json([runSummary()]);
      if (url.includes("/runs/run_1/events")) {
        return new Response('id: 1\ndata: {"type":"assistant_delta","text":"hello","fleetEventId":1}\n\nid: 2\ndata: {"type":"fleet_run_status","runId":"run_1","status":"completed","fleetEventId":2}\n\n', {
          headers: { "content-type": "text/event-stream" }
        });
      }
      return Response.json({
        runId: "run_1",
        status: "completed",
        eventCount: 2,
        lastEventId: 2,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z"
      });
    };
    const client = new CrewCoderClient({ baseUrl: "http://127.0.0.1:8787", token, fetch: fetchImpl });

    await expect(client.health()).resolves.toMatchObject({ ok: true, authentication: "bearer", protocolVersion: CREWCODER_FLEET_PROTOCOL_VERSION, durability: "persistent" });
    await expect(client.createRun({ prompt: "hello" })).resolves.toMatchObject({ runId: "run_1" });
    await expect(client.listRuns()).resolves.toEqual([expect.objectContaining({ runId: "run_1", lastEventId: 2 })]);
    await expect(client.getRun("run_1")).resolves.toMatchObject({ status: "completed", eventCount: 2 });
    await expect(client.waitForRun("run_1")).resolves.toMatchObject({ status: "completed" });
    await expect(client.control("run_1", { type: "control", action: "abort" })).resolves.toBe(true);
    const events: string[] = [];
    await client.streamEvents("run_1", (event) => { events.push(event.type); }, { replay: true });

    expect(events).toEqual(["assistant_delta", "fleet_run_status"]);
    expect(requests.find((request) => request.url.endsWith("/health"))?.authorization).toBeNull();
    expect(requests.filter((request) => !request.url.endsWith("/health")).every((request) => request.authorization === `Bearer ${token}`)).toBe(true);
  });

  it("keeps WebSocket credentials out of the URL", () => {
    const client = new CrewCoderFleetClient({ baseUrl: "https://runner.example.com", token });

    const connection = client.webSocketConnection("run with spaces");

    expect(connection.url).toBe("wss://runner.example.com/runs/run%20with%20spaces/ws");
    expect(connection.url).not.toContain(token);
    expect(connection.protocols).toEqual(["crewcoder.v1", `crewcoder.auth.${token}`]);

    const resumed = client.webSocketConnection("run with spaces", 42);
    expect(resumed.url).toBe("wss://runner.example.com/runs/run%20with%20spaces/ws?after=42");
  });

  it("rejects weak tokens and failed authenticated requests", async () => {
    expect(() => new CrewCoderFleetClient({ baseUrl: "http://localhost:8787", token: "short" })).toThrow("at least 32");
    const client = new CrewCoderFleetClient({
      baseUrl: "http://localhost:8787",
      token,
      fetch: async () => new Response('{"error":"Unauthorized"}', { status: 401 })
    });
    const request = client.createRun({ prompt: "hello" });
    await expect(request).rejects.toBeInstanceOf(CrewCoderFleetRequestError);
    await expect(request).rejects.toMatchObject({ code: "REQUEST_FAILED", status: 401, retryable: false });
  });

  it("reconnects SSE from the last event cursor without duplicates", async () => {
    const urls: string[] = [];
    let attempt = 0;
    const client = new CrewCoderFleetClient({
      baseUrl: "http://localhost:8787",
      token,
      reconnect: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 2 },
      fetch: async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        urls.push(url);
        attempt += 1;
        if (attempt === 1) return new Response('id: 1\ndata: {"type":"assistant_delta","text":"first"}\n\n');
        return new Response('id: 2\ndata: {"type":"fleet_run_status","runId":"run_1","status":"completed"}\n\n');
      }
    });
    const events: Array<{ type: string; id?: number }> = [];
    const reconnects: Array<{ attempt: number; after: number }> = [];

    await client.streamEvents("run_1", (event) => {
      events.push({ type: event.type, id: event.fleetEventId });
    }, {
      onReconnect: (reconnectAttempt, afterEventId) => { reconnects.push({ attempt: reconnectAttempt, after: afterEventId }); }
    });

    expect(events).toEqual([
      { type: "assistant_delta", id: 1 },
      { type: "fleet_run_status", id: 2 }
    ]);
    expect(reconnects).toEqual([{ attempt: 1, after: 1 }]);
    expect(urls[1]).toContain("after=1");
  });

  it("uses typed argument and protocol errors", async () => {
    expect(() => new CrewCoderFleetClient({ baseUrl: "ftp://localhost", token })).toThrow(CrewCoderError);
    const client = new CrewCoderFleetClient({
      baseUrl: "http://localhost:8787",
      token,
      fetch: async () => Response.json({ unexpected: true })
    });
    await expect(client.getRun("run_1")).rejects.toBeInstanceOf(CrewCoderFleetProtocolError);
  });
});

function runSummary(): Record<string, unknown> {
  return {
    runId: "run_1",
    status: "completed",
    eventCount: 2,
    lastEventId: 2,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z"
  };
}
