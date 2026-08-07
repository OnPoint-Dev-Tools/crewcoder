import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assistantText, textMessage } from "../core/messages.js";
import { runAgentLoop } from "../core/agent-loop.js";
import type { ModelClient } from "../core/model-client.js";
import type { ToolDefinition } from "../core/tool-types.js";
import { delegateWorkerTool } from "../tools/delegate-worker.js";
import { createWorker } from "../core/identity.js";
import { saveSession } from "../core/session-store.js";
import { loadSession } from "../core/session-loader.js";
import { handoffToWorker, parseWorkerList, parseWorkerRef, runWorkerCrew } from "../core/worker-crews.js";
import { buildTeamPrompt, loadWorkerTeams, resolveWorkerTeam, teamWorkerNames } from "../core/worker-teams.js";

describe("worker crews", () => {
  it("parses unique worker lists", () => {
    expect(parseWorkerList("reviewer,builder, reviewer ")).toEqual(["reviewer", "builder"]);
    expect(() => parseWorkerList(" , ")).toThrow(/at least one worker/i);
  });

  it("requires explicit worker handoff refs", () => {
    expect(parseWorkerRef("worker:reviewer")).toBe("reviewer");
    expect(() => parseWorkerRef("reviewer")).toThrow(/worker:<name>/i);
  });

  it("runs each named worker in its own session", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-crew-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-home-"));
    const originalHome = process.env.CREWCODER_HOME;
    process.env.CREWCODER_HOME = home;
    try {
      createWorker("reviewer", { description: "Reviews code." });
      createWorker("builder", { description: "Builds code." });
      const seenPrompts: string[] = [];
      const result = await runWorkerCrew({ prompt: "ship feature", workers: ["reviewer", "builder"], requestedMode: "general", cwd }, {
        maxIterations: 1,
        sessionIdFactory: (worker) => `session_${worker}`,
        createModelClient: (worker): ModelClient => ({
          async complete(input) {
            seenPrompts.push(input.systemPrompt);
            expect(input.session?.sessionId).toBe(`session_${worker}`);
            return assistantText(`${worker} done`);
          }
        })
      });
      expect(result.workers.map((worker) => worker.worker)).toEqual(["reviewer", "builder"]);
      expect(result.workers.map((worker) => worker.sessionId)).toEqual(["session_reviewer", "session_builder"]);
      expect(seenPrompts[0]).toContain("You are reviewer");
      expect(seenPrompts[1]).toContain("You are builder");
    } finally {
      if (originalHome === undefined) delete process.env.CREWCODER_HOME;
      else process.env.CREWCODER_HOME = originalHome;
    }
  });

  it("emits crew and per-worker lifecycle events", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-crew-events-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-home-"));
    const originalHome = process.env.CREWCODER_HOME;
    process.env.CREWCODER_HOME = home;
    try {
      createWorker("reviewer", { description: "Reviews code." });
      createWorker("builder", { description: "Builds code." });
      const events: Array<{ type: string; worker?: string; status?: string }> = [];
      await runWorkerCrew({ prompt: "ship feature", workers: ["reviewer", "builder"], requestedMode: "general", cwd }, {
        maxIterations: 1,
        sessionIdFactory: (worker) => `session_${worker}`,
        createModelClient: (worker): ModelClient => ({ async complete() { return assistantText(`${worker} done`); } }),
        emit(event) { events.push(event); }
      });

      expect(events.filter((event) => event.type.startsWith("crew"))).toEqual([
        { type: "crew_start", workers: ["reviewer", "builder"] },
        { type: "crew_worker_start", worker: "reviewer", index: 0, total: 2, sessionId: "session_reviewer" },
        { type: "crew_worker_end", worker: "reviewer", index: 0, total: 2, status: "completed", sessionId: "session_reviewer" },
        { type: "crew_worker_start", worker: "builder", index: 1, total: 2, sessionId: "session_builder" },
        { type: "crew_worker_end", worker: "builder", index: 1, total: 2, status: "completed", sessionId: "session_builder" },
        { type: "crew_end", total: 2, completed: 2, failed: 0 }
      ]);
    } finally {
      if (originalHome === undefined) delete process.env.CREWCODER_HOME;
      else process.env.CREWCODER_HOME = originalHome;
    }
  });

  it("marks terminal worker results as failed without hiding later workers", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-crew-failure-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-home-"));
    const originalHome = process.env.CREWCODER_HOME;
    process.env.CREWCODER_HOME = home;
    try {
      createWorker("broken", { description: "Fails." });
      createWorker("healthy", { description: "Continues." });
      const lifecycle: Array<Record<string, unknown>> = [];
      const result = await runWorkerCrew({ prompt: "ship feature", workers: ["broken", "healthy"], requestedMode: "general", cwd }, {
        maxIterations: 1,
        createModelClient: (worker): ModelClient => ({
          async complete() {
            return worker === "broken"
              ? { ...assistantText("provider unavailable"), stopReason: "error", errorMessage: "provider unavailable" }
              : assistantText("healthy done");
          }
        }),
        emit(event) { if (event.type.startsWith("crew")) lifecycle.push(event); }
      });

      expect(result.workers.map((worker) => worker.worker)).toEqual(["broken", "healthy"]);
      expect(lifecycle).toContainEqual(expect.objectContaining({ type: "crew_worker_end", worker: "broken", status: "failed", error: "provider unavailable" }));
      expect(lifecycle).toContainEqual(expect.objectContaining({ type: "crew_worker_end", worker: "healthy", status: "completed" }));
      expect(lifecycle.at(-1)).toEqual({ type: "crew_end", total: 2, completed: 1, failed: 1 });
    } finally {
      if (originalHome === undefined) delete process.env.CREWCODER_HOME;
      else process.env.CREWCODER_HOME = originalHome;
    }
  });

  it("lets an agent delegate a scoped subtask to a child worker", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-delegate-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-home-"));
    const originalHome = process.env.CREWCODER_HOME;
    process.env.CREWCODER_HOME = home;
    try {
      createWorker("researcher", { description: "Researches docs." });
      let call = 0;
      const modelClient: ModelClient = {
        async complete(input) {
          call += 1;
          if (call === 1) {
            expect(input.availableTools.map((tool) => tool.name)).toContain("delegateWorker");
            return { role: "assistant", content: [{ type: "toolCall", id: "delegate-1", name: "delegateWorker", arguments: { worker: "researcher", task: "Find docs on worker teams", maxIterations: 1 } }], stopReason: "tool_calls", timestamp: Date.now() };
          }
          if (call === 2) {
            expect(input.systemPrompt).toContain("You are researcher");
            expect(JSON.stringify(input.messages)).toContain("Find docs on worker teams");
            expect(input.session?.resumeFromSessionId).toBe("session_parent");
            return assistantText("research summary");
          }
          expect(JSON.stringify(input.messages)).toContain("research summary");
          return assistantText("parent done");
        }
      };
      const result = await runAgentLoop({ prompt: "coordinate research", requestedMode: "general", cwd }, { sessionId: "session_parent", maxIterations: 2, modelClient });
      expect(result.summary).toContain("parent done");
      expect(call).toBe(3);
    } finally {
      if (originalHome === undefined) delete process.env.CREWCODER_HOME;
      else process.env.CREWCODER_HOME = originalHome;
    }
  });

  it("lets a delegated child worker run past the old two-turn cap", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-delegate-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-home-"));
    const originalHome = process.env.CREWCODER_HOME;
    process.env.CREWCODER_HOME = home;
    try {
      createWorker("researcher", { description: "Researches docs." });
      const reader: ToolDefinition = {
        name: "read",
        description: "Read a file.",
        parse: (args) => args,
        async execute() { return { content: [{ type: "text", text: "ok" }] }; }
      };
      let parentCalls = 0;
      let childCalls = 0;
      const modelClient: ModelClient = {
        async complete(input) {
          const isChild = input.systemPrompt.includes("You are researcher");
          if (isChild) {
            childCalls += 1;
            // Six tool turns: more than the old default of 2 allowed.
            if (childCalls <= 6) {
              return { role: "assistant", content: [{ type: "toolCall", id: `child-${childCalls}`, name: "read", arguments: { path: `file-${childCalls}.ts` } }], stopReason: "tool_calls", timestamp: Date.now() };
            }
            return assistantText("deep research summary");
          }
          parentCalls += 1;
          if (parentCalls === 1) {
            return { role: "assistant", content: [{ type: "toolCall", id: "delegate-1", name: "delegateWorker", arguments: { worker: "researcher", task: "Audit the module" } }], stopReason: "tool_calls", timestamp: Date.now() };
          }
          return assistantText("parent done");
        }
      };

      const result = await runAgentLoop({ prompt: "coordinate", requestedMode: "general", cwd }, {
        sessionId: "session_parent",
        modelClient,
        tools: [reader, delegateWorkerTool]
      });

      expect(childCalls).toBe(7);
      expect(result.summary).toContain("parent done");
      expect(JSON.stringify(result.messages)).toContain("deep research summary");
    } finally {
      if (originalHome === undefined) delete process.env.CREWCODER_HOME;
      else process.env.CREWCODER_HOME = originalHome;
    }
  });

  it("hands off an existing transcript to a new worker session", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-handoff-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-home-"));
    const originalHome = process.env.CREWCODER_HOME;
    process.env.CREWCODER_HOME = home;
    try {
      createWorker("reviewer", { description: "Reviews code." });
      await saveSession({
        id: "session_source",
        startedAt: new Date().toISOString(),
        cwd,
        requestedMode: "general",
        resolvedMode: "general",
        prompt: "build feature",
        events: [],
        messages: [textMessage("user", "build feature"), assistantText("implemented feature")],
        mutationLog: ["src/feature.ts"]
      });
      const result = await handoffToWorker({ sessionId: "session_source", workerRef: "worker:reviewer", prompt: "review it" }, {
        maxIterations: 1,
        sessionIdFactory: () => "session_reviewer_handoff",
        createModelClient: (): ModelClient => ({
          async complete(input) {
            expect(input.systemPrompt).toContain("You are reviewer");
            expect(JSON.stringify(input.messages)).toContain("implemented feature");
            expect(input.session).toMatchObject({ sessionId: "session_reviewer_handoff", resumeFromSessionId: "session_source", continuation: true });
            return assistantText("review complete");
          }
        })
      });
      expect(result.sourceSessionId).toBe("session_source");
      expect(result.worker).toBe("reviewer");
      expect(result.sessionId).toBe("session_reviewer_handoff");
      const saved = await loadSession(result.sessionId);
      expect(saved.parentSessionId).toBe("session_source");
      expect(saved.mutationLog).toEqual(["src/feature.ts"]);
    } finally {
      if (originalHome === undefined) delete process.env.CREWCODER_HOME;
      else process.env.CREWCODER_HOME = originalHome;
    }
  });

  it("loads worker teams from crewcoder.json and builds role prompts", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-team-"));
    fs.writeFileSync(path.join(cwd, "crewcoder.json"), JSON.stringify({
      teams: {
        feature: {
          description: "Feature delivery team",
          roles: [
            { worker: "architect", role: "Plan", prompt: "Design first." },
            { worker: "builder", role: "Build", prompt: "Implement second." }
          ],
          handoffRules: ["architect before builder"],
          sharedMemory: ["Prefer small diffs"]
        }
      }
    }), "utf8");
    const manifest = loadWorkerTeams(cwd);
    expect(manifest?.teams.map((team) => team.id)).toEqual(["feature"]);
    const team = resolveWorkerTeam("feature", cwd);
    expect(teamWorkerNames(team)).toEqual(["architect", "builder"]);
    const prompt = buildTeamPrompt(team, "ship checkout", team.roles[0]!);
    expect(prompt).toContain("Worker team: feature");
    expect(prompt).toContain("Your team role: Plan");
    expect(prompt).toContain("Prefer small diffs");
    expect(prompt).toContain("ship checkout");
  });
});
