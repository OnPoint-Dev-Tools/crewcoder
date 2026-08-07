import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { startFleetServer } from "../core/fleet-server.js";
import { createFleetDeployPlan } from "../core/fleet-deploy.js";
import { fleetWebSocketProtocols } from "../core/fleet-auth.js";
import { FleetRunStore, FLEET_RUN_STORE_VERSION } from "../core/fleet-store.js";

const authToken = "test_fleet_token_1234567890_abcdefghijklmno";
const authHeaders = { authorization: `Bearer ${authToken}` };

describe("fleet server", () => {
  it("serves health, runs agents, and replays events over SSE", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-fleet-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-home-"));
    const originalHome = process.env.CREWCODER_HOME;
    process.env.CREWCODER_HOME = home;
    const server = await startFleetServer({ host: "127.0.0.1", port: 0, cwd, authToken });
    try {
      const health = await fetch(`${server.url}/health`);
      await expect(health.json()).resolves.toMatchObject({
        ok: true,
        service: "crewcoder-fleet",
        authentication: "bearer",
        protocolVersion: "1.0",
        durability: "persistent"
      });

      const unauthorized = await fetch(`${server.url}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "must not run", heuristic: true })
      });
      expect(unauthorized.status).toBe(401);
      expect(unauthorized.headers.get("www-authenticate")).toContain("Bearer");

      const created = await fetch(`${server.url}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders },
        body: JSON.stringify({ prompt: "hello fleet", mode: "general", heuristic: true, maxIterations: 1, cwd })
      });
      expect(created.status).toBe(202);
      const body = await created.json() as { runId: string; eventUrl: string; wsUrl: string };
      expect(body.runId).toMatch(/^run_/);
      expect(body.eventUrl).toBe(`/runs/${body.runId}/events`);
      expect(body.wsUrl).toBe(`/runs/${body.runId}/ws`);

      const summary = await waitForRun(server.url, body.runId, authToken);
      expect(summary).toMatchObject({ runId: body.runId, status: "completed" });

      const events = await fetch(`${server.url}${body.eventUrl}?replay=1`, { headers: authHeaders });
      const text = await events.text();
      expect(text).toContain("agent_start");
      expect(text).toContain("session_saved");
      expect(text).toContain("fleet_run_status");
    } finally {
      await server.close();
      if (originalHome === undefined) delete process.env.CREWCODER_HOME;
      else process.env.CREWCODER_HOME = originalHome;
    }
  });

  it("authenticates WebSocket upgrades without placing the token in the URL", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-fleet-ws-"));
    const server = await startFleetServer({ host: "127.0.0.1", port: 0, cwd, authToken, persistRuns: false });
    try {
      const created = await fetch(`${server.url}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders },
        body: JSON.stringify({ prompt: "websocket auth", heuristic: true, maxIterations: 1 })
      });
      const body = await created.json() as { runId: string };
      const unauthorized = await webSocketHandshake(server.port, `/runs/${body.runId}/ws`, []);
      expect(unauthorized).toContain("401 Unauthorized");

      const authorized = await webSocketHandshake(server.port, `/runs/${body.runId}/ws`, fleetWebSocketProtocols(authToken));
      expect(authorized).toContain("101 Switching Protocols");
      expect(authorized).toContain("Sec-WebSocket-Protocol: crewcoder.v1");
    } finally {
      await server.close();
    }
  });

  it("recovers durable runs and resumes event replay from cursors", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-fleet-durable-"));
    const runStoreDir = path.join(cwd, "fleet-runs");
    const firstServer = await startFleetServer({ host: "127.0.0.1", port: 0, cwd, authToken, runStoreDir });
    const created = await fetch(`${firstServer.url}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({ prompt: "persist this run", heuristic: true, maxIterations: 1 })
    });
    const createdBody = await created.json() as { runId: string };
    const firstSummary = await waitForRun(firstServer.url, createdBody.runId, authToken);
    expect(firstSummary.status).toBe("completed");
    const lastEventId = firstSummary.lastEventId as number;
    await firstServer.close();

    const secondServer = await startFleetServer({ host: "127.0.0.1", port: 0, cwd, authToken, runStoreDir });
    try {
      const listed = await fetch(`${secondServer.url}/runs`, { headers: authHeaders });
      await expect(listed.json()).resolves.toEqual([
        expect.objectContaining({ runId: createdBody.runId, status: "completed", lastEventId })
      ]);
      const replay = await fetch(`${secondServer.url}/runs/${createdBody.runId}/events?replay=1&after=${lastEventId - 1}`, { headers: authHeaders });
      const replayText = await replay.text();
      expect(replayText).toContain(`id: ${lastEventId}`);
      expect(replayText).toContain("fleet_run_status");
      expect(replayText).not.toContain(`id: ${lastEventId - 1}\n`);
      expect(fs.statSync(path.join(runStoreDir, createdBody.runId, "run.json")).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.join(runStoreDir, createdBody.runId, "events.jsonl")).mode & 0o777).toBe(0o600);
    } finally {
      await secondServer.close();
    }
  });

  it("marks persisted in-flight runs interrupted after restart", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-fleet-interrupted-"));
    const runStoreDir = path.join(cwd, "fleet-runs");
    const store = new FleetRunStore(runStoreDir);
    const runId = "run_interrupted_test";
    const timestamp = new Date().toISOString();
    store.writeMetadata({
      version: FLEET_RUN_STORE_VERSION,
      runId,
      request: { prompt: "was running", cwd },
      status: "running",
      createdAt: timestamp,
      updatedAt: timestamp,
      eventCount: 1,
      lastEventId: 1
    });
    store.appendEvent(runId, {
      id: 1,
      emittedAt: timestamp,
      event: { type: "fleet_run_created", runId, status: "running" }
    });

    const server = await startFleetServer({ host: "127.0.0.1", port: 0, cwd, authToken, runStoreDir });
    try {
      const summary = await fetch(`${server.url}/runs/${runId}`, { headers: authHeaders });
      await expect(summary.json()).resolves.toMatchObject({
        runId,
        status: "failed",
        error: "Fleet run interrupted by server restart.",
        eventCount: 2,
        lastEventId: 2
      });
      const replay = await fetch(`${server.url}/runs/${runId}/events?replay=1&after=1`, { headers: authHeaders });
      const replayText = await replay.text();
      expect(replayText).toContain("\"interrupted\":true");
      expect(replayText).toContain("id: 2");
    } finally {
      await server.close();
    }
  });

  it("builds a dry-run npm deploy plan", () => {
    const plan = createFleetDeployPlan("deploy@example.com", { remoteDir: "~/runner", host: "0.0.0.0", port: 9999 });
    expect(plan.target).toBe("deploy@example.com");
    expect(plan.format).toBe("npm");
    expect(plan.commands.some((command) => command.includes("crewcoder serve --host 0.0.0.0 --port 9999"))).toBe(true);
    expect(plan.commands.some((command) => command.startsWith("ssh deploy@example.com"))).toBe(true);
  });

  it("builds an SSH-only standalone binary deploy plan", () => {
    const plan = createFleetDeployPlan("deploy@example.com", {
      remoteDir: "~/runner",
      host: "127.0.0.1",
      port: 8787,
      binaryPath: "/tmp/crewcoder-linux-x64"
    });
    expect(plan).toMatchObject({
      format: "binary",
      artifactPath: "/tmp/crewcoder-linux-x64",
      tokenPath: "~/runner/.crewcoder/fleet-token"
    });
    expect(plan.commands).toContain("test -x /tmp/crewcoder-linux-x64");
    expect(plan.commands.some((command) => command.includes("scp /tmp/crewcoder-linux-x64 deploy@example.com:~/runner/crewcoder"))).toBe(true);
    expect(plan.commands.some((command) => command.includes("CREWCODER_HOME=\"$PWD/.crewcoder\" nohup ./crewcoder serve --host 127.0.0.1 --port 8787"))).toBe(true);
  });

  it("refuses to expose a standalone runner without transport authentication", () => {
    expect(() => createFleetDeployPlan("deploy@example.com", {
      host: "0.0.0.0",
      binaryPath: "/tmp/crewcoder-linux-x64"
    })).toThrow("SSH-only");
  });
});

async function waitForRun(url: string, runId: string, token: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 30; i++) {
    const response = await fetch(`${url}/runs/${runId}`, { headers: { authorization: `Bearer ${token}` } });
    const summary = await response.json() as Record<string, unknown>;
    if (summary.status === "completed" || summary.status === "failed") return summary;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for fleet run.");
}

function webSocketHandshake(port: number, requestPath: string, protocols: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let response = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Timed out waiting for WebSocket handshake."));
    }, 2_000);
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on("data", (chunk) => {
      response += chunk.toString("latin1");
      if (!response.includes("\r\n\r\n")) return;
      clearTimeout(timer);
      socket.destroy();
      resolve(response);
    });
    socket.once("connect", () => {
      const protocolHeader = protocols.length ? `Sec-WebSocket-Protocol: ${protocols.join(", ")}\r\n` : "";
      socket.write([
        `GET ${requestPath} HTTP/1.1`,
        "Host: 127.0.0.1",
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version: 13",
        protocolHeader.trimEnd(),
        "",
        ""
      ].filter((line, index, lines) => line || index >= lines.length - 2).join("\r\n"));
    });
  });
}
