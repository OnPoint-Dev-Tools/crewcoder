import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAgentLoop } from "../core/agent-loop.js";
import { checkGoalCompletion, createGoalTools, decideGoalApproval, type GoalCompletionSignal } from "../core/goal-runner.js";
import { createGoal, listGoals, loadGoal, saveGoal } from "../core/goal-store.js";
import { readConfig, setConfigValue } from "../core/config.js";
import { assistantText } from "../core/messages.js";
import type { ModelClient } from "../core/model-client.js";

const originalHome = process.env.CREWCODER_HOME;
let home: string;
let cwd: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-goals-"));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-goal-workspace-"));
  process.env.CREWCODER_HOME = home;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.CREWCODER_HOME;
  else process.env.CREWCODER_HOME = originalHome;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe("durable goals", () => {
  it("normalizes and updates goal verifier configuration", () => {
    expect(readConfig().goals).toEqual({ maxTurns: 200, timeoutMinutes: 480 });
    setConfigValue("goals.maxTurns", "25");
    setConfigValue("goals.checkModel", "gpt-5.6-luna");
    setConfigValue("goals.timeoutMinutes", "90");
    expect(readConfig().goals).toEqual({ maxTurns: 25, checkModel: "gpt-5.6-luna", timeoutMinutes: 90 });
    expect(() => setConfigValue("goals.maxTurns", "0")).toThrow(/integer from 1/i);
  });

  it("persists goal state atomically and allows only one active goal per workspace", async () => {
    const goal = await createGoal({
      objective: "Migrate the project and prove tests pass",
      cwd,
      provider: "codex",
      model: "gpt-test",
      mode: "general",
      approvalMode: "review"
    });

    expect((await loadGoal(goal.id)).objective).toContain("prove tests pass");
    expect((await listGoals(cwd)).map((record) => record.id)).toEqual([goal.id]);
    await expect(createGoal({ objective: "second", cwd, provider: "codex", model: "gpt-test", mode: "general", approvalMode: "review" })).rejects.toThrow(/already queued/i);

    await saveGoal({ ...goal, status: "cancelled" });
    await expect(createGoal({ objective: "replacement", cwd, provider: "codex", model: "gpt-test", mode: "general", approvalMode: "review" })).resolves.toMatchObject({ status: "queued" });
  });

  it("persists an approval decision for a detached waiting worker", async () => {
    const goal = await createGoal({ objective: "Run reviewed migration", cwd, provider: "codex", model: "gpt-test", mode: "general", approvalMode: "review" });
    await saveGoal({
      ...goal,
      status: "awaiting_approval",
      pendingApproval: { approvalId: "approval_1", toolCallId: "call_1", toolName: "bash", reason: "Review command", args: { command: "npm test" } }
    });

    const decided = await decideGoalApproval(goal.id, true, { reason: "Approved after review" });
    expect(decided.pendingApproval?.decision).toEqual({ approved: true, reason: "Approved after review" });
  });

  it("requires explicit completion evidence through the goal tool", async () => {
    const signals: GoalCompletionSignal[] = [];
    const tools = createGoalTools((signal) => { signals.push(signal); });
    const client: ModelClient = {
      async complete() {
        return {
          role: "assistant",
          content: [{ type: "toolCall", id: "complete-1", name: "complete_goal", arguments: { summary: "Migration complete", evidence: "npm test passed" } }],
          stopReason: "tool_calls",
          timestamp: Date.now()
        };
      }
    };

    const result = await runAgentLoop({ prompt: "finish goal", requestedMode: "general", cwd }, {
      modelClient: client,
      additionalTools: tools,
      maxIterations: 2,
      approvalMode: "full-access"
    });

    expect(signals).toEqual([{ kind: "completed", summary: "Migration complete", evidence: "npm test passed" }]);
    expect(result.messages.some((message) => message.role === "toolResult" && message.details?.goalStatus === "completed")).toBe(true);
  });

  it("uses a strict tool-free independent verifier verdict", async () => {
    const goal = await createGoal({ objective: "Pass every contract test", cwd, provider: "codex", model: "maker", mode: "general", approvalMode: "review", checkModel: "checker" });
    const makerResult = await runAgentLoop({ prompt: "work", requestedMode: "general", cwd }, {
      maxIterations: 1,
      modelClient: { async complete() { return assistantText("Implemented the change; tests passed."); } }
    });
    const checker: ModelClient = {
      async complete(input) {
        expect(input.availableTools).toEqual([]);
        expect(input.systemPrompt).toContain("independent goal verifier");
        expect(JSON.stringify(input.messages)).toContain("Pass every contract test");
        return assistantText('{"verdict":"continue","reason":"No concrete test command output was supplied","evidence":""}');
      }
    };

    const verdict = await checkGoalCompletion({ goal, result: makerResult, checkModel: "checker" }, checker);
    expect(verdict).toMatchObject({ verdict: "continue", model: "checker", reason: "No concrete test command output was supplied" });
  });

  it("rejects malformed verifier output", async () => {
    const goal = await createGoal({ objective: "Finish", cwd, provider: "codex", model: "maker", mode: "general", approvalMode: "review", checkModel: "checker" });
    const makerResult = await runAgentLoop({ prompt: "work", requestedMode: "general", cwd }, { maxIterations: 1, modelClient: { async complete() { return assistantText("done"); } } });
    await expect(checkGoalCompletion({ goal, result: makerResult, checkModel: "checker" }, { async complete() { return assistantText("probably done"); } })).rejects.toThrow(/invalid JSON/i);
  });

  it("rejects completion without concrete evidence", () => {
    const complete = createGoalTools(() => undefined).find((tool) => tool.name === "complete_goal");
    expect(() => complete?.parse({ summary: "done", evidence: "" })).toThrow(/evidence is required/i);
  });
});
