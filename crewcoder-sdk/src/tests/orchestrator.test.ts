import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorker } from "@onpoint-dev-tools/crewcoder-agent";
import { createCrewCoderOrchestrator, createCrewCoderSession, type AgentEvent, type ModelClient } from "../index.js";

let root = "";
let previousHome: string | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-sdk-orchestrator-"));
  previousHome = process.env.CREWCODER_HOME;
  process.env.CREWCODER_HOME = path.join(root, "home");
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.CREWCODER_HOME;
  else process.env.CREWCODER_HOME = previousHome;
  fs.rmSync(root, { recursive: true, force: true });
});

function deterministicModel(): ModelClient {
  return {
    async complete(input) {
      const worker = input.systemPrompt.match(/You are ([^,]+),/)?.[1] ?? "worker";
      return { role: "assistant", content: [{ type: "text", text: `${worker} complete` }], stopReason: "end", timestamp: Date.now() };
    }
  };
}

describe("CrewCoderOrchestrator", () => {
  it("runs workers sequentially in separate durable sessions and emits lifecycle events", async () => {
    createWorker("reviewer", { description: "Reviews." });
    createWorker("builder", { description: "Builds." });
    const events: AgentEvent[] = [];
    const orchestrator = createCrewCoderOrchestrator({ cwd: root, modelClient: deterministicModel(), maxIterations: 1 });
    orchestrator.subscribe((event) => { events.push(event); });

    const result = await orchestrator.runCrew({ prompt: "Ship it", workers: ["reviewer", "builder"] });

    expect(result.workers.map((item) => item.worker)).toEqual(["reviewer", "builder"]);
    expect(new Set(result.workers.map((item) => item.sessionId)).size).toBe(2);
    expect(events.filter((event) => event.type === "crew_worker_start").map((event) => "worker" in event ? event.worker : "")).toEqual(["reviewer", "builder"]);
  });

  it("loads and runs declarative teams", async () => {
    createWorker("architect", { description: "Plans." });
    createWorker("builder", { description: "Builds." });
    fs.writeFileSync(path.join(root, "crewcoder.json"), JSON.stringify({ teams: { feature: { roles: [{ worker: "architect", role: "Plan" }, { worker: "builder", role: "Build" }] } } }), "utf8");
    const orchestrator = createCrewCoderOrchestrator({ cwd: root, modelClient: deterministicModel(), maxIterations: 1 });

    expect(orchestrator.listTeams()?.teams.map((team) => team.id)).toEqual(["feature"]);
    expect(orchestrator.getTeam("feature").roles).toHaveLength(2);
    expect((await orchestrator.runTeam({ teamId: "feature", prompt: "Ship it" })).workers).toHaveLength(2);
  });

  it("hands a durable transcript to a new worker session and rejects traversal ids", async () => {
    createWorker("reviewer", { description: "Reviews." });
    const source = await createCrewCoderSession({ cwd: root, modelClient: deterministicModel() }).prompt("Build it");
    const orchestrator = createCrewCoderOrchestrator({ cwd: root, modelClient: deterministicModel(), maxIterations: 1 });

    const result = await orchestrator.handoff({ sessionId: source.sessionId, worker: "reviewer", prompt: "Review it" });
    expect(result.sourceSessionId).toBe(source.sessionId);
    expect(result.worker).toBe("reviewer");
    expect(result.sessionId).not.toBe(source.sessionId);
    await expect(orchestrator.handoff({ sessionId: "../outside", worker: "reviewer" })).rejects.toThrow(/Session id/);
  });

  it("rejects overlapping orchestration runs", async () => {
    createWorker("reviewer", { description: "Reviews." });
    let release: (() => void) | undefined;
    let enteredResolve: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    const modelClient: ModelClient = { async complete() { enteredResolve?.(); await new Promise<void>((resolve) => { release = resolve; }); return { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "end", timestamp: Date.now() }; } };
    const orchestrator = createCrewCoderOrchestrator({ cwd: root, modelClient });
    const first = orchestrator.runCrew({ prompt: "first", workers: ["reviewer"] });
    await entered;

    await expect(orchestrator.runCrew({ prompt: "second", workers: ["reviewer"] })).rejects.toThrow(/already running/);
    release?.();
    await first;
  });
});
