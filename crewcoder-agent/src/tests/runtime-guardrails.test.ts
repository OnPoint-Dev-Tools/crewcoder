import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runAgentLoop } from "../core/agent-loop.js";
import { runAgentLoopContinue } from "../core/agent-loop-continue.js";
import { loadSession } from "../core/session-loader.js";
import { assistantText } from "../core/messages.js";
import type { AgentEvent } from "../core/events.js";
import type { ModelClient } from "../core/model-client.js";
import { parseTokenBudget, tokenBudgetStatus } from "../core/token-budget.js";
import { runVerificationChecks } from "../core/verification.js";

function homeTest(): { cwd: string; restore(): void } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-guardrails-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-home-"));
  const original = process.env.CREWCODER_HOME;
  process.env.CREWCODER_HOME = home;
  return { cwd, restore() { if (original === undefined) delete process.env.CREWCODER_HOME; else process.env.CREWCODER_HOME = original; } };
}

describe("runtime guardrails", () => {
  it("parses token budget shorthand and computes burn rate", () => {
    expect(parseTokenBudget("200k")).toBe(200_000);
    expect(parseTokenBudget("1.5m")).toBe(1_500_000);
    expect(tokenBudgetStatus({ turns: 1, totalTokens: 80_000 }, 100_000)).toMatchObject({ percent: 80, warningReached: true, exceeded: false });
    expect(() => parseTokenBudget("free")).toThrow(/token budget/i);
  });

  it("warns at 80 percent and stops pending tools after the hard limit", async () => {
    const test = homeTest();
    try {
      let calls = 0;
      const events: AgentEvent[] = [];
      const client: ModelClient = { async complete(_input, _signal, stream) {
        calls += 1;
        await stream?.onUsage?.({ providerId: "test", totalTokens: 105 });
        return { role: "assistant", content: [{ type: "toolCall", id: "danger", name: "missing", arguments: {} }], stopReason: "tool_calls", timestamp: Date.now() };
      } };
      const result = await runAgentLoop({ prompt: "work", requestedMode: "general", cwd: test.cwd }, { modelClient: client, tokenBudget: 100, maxIterations: 3, emit: (event) => { events.push(event); } });
      expect(calls).toBe(1);
      expect(events.some((event) => event.type === "token_budget_warning")).toBe(true);
      const exceeded = events.find((event) => event.type === "token_budget_exceeded");
      expect(exceeded).toMatchObject({ sessionId: result.sessionId, limit: 100 });
      expect(exceeded?.type === "token_budget_exceeded" ? exceeded.handoffSummary : "").toContain("user: work");
      expect(events.some((event) => event.type === "tool_execution_start")).toBe(false);
      expect(result.budgetExceeded).toBe(true);
      expect(result.usage).toMatchObject({ tokenBudget: 100, budgetExceeded: true });
    } finally { test.restore(); }
  });

  it("persists a session budget and enforces it on resume", async () => {
    const test = homeTest();
    try {
      const first = await runAgentLoop({ prompt: "first", requestedMode: "general", cwd: test.cwd }, {
        tokenBudget: 100,
        maxIterations: 1,
        modelClient: { async complete(_input, _signal, stream) { await stream?.onUsage?.({ providerId: "test", totalTokens: 90 }); return assistantText("done"); } }
      });
      let resumedCalls = 0;
      const resumed = await runAgentLoopContinue({ sessionId: first.sessionId, prompt: "continue" }, {
        maxIterations: 1,
        modelClient: { async complete(_input, _signal, stream) { resumedCalls += 1; await stream?.onUsage?.({ providerId: "test", totalTokens: 20 }); return assistantText("done"); } }
      });
      expect(resumedCalls).toBe(1);
      expect(resumed.usage.totalTokens).toBe(110);
      expect(resumed.budgetExceeded).toBe(true);
    } finally { test.restore(); }
  });

  it("links a summary-only fresh session to its budget-exhausted parent", async () => {
    const test = homeTest();
    try {
      const child = await runAgentLoop({ prompt: "Compacted handoff only", requestedMode: "general", cwd: test.cwd }, {
        parentSessionId: "session_exhausted",
        maxIterations: 1,
        modelClient: { async complete(input) { expect(input.messages).toHaveLength(1); expect(JSON.stringify(input.messages)).toContain("Compacted handoff only"); return assistantText("continued"); } }
      });
      expect((await loadSession(child.sessionId)).parentSessionId).toBe("session_exhausted");
    } finally { test.restore(); }
  });

  it("runs verification commands and records failures", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-verify-"));
    const results = await runVerificationChecks([
      { id: "pass", title: "Pass", command: process.execPath, args: ["-e", "console.log('ok')"], cwd, timeoutMs: 2_000 },
      { id: "fail", title: "Fail", command: process.execPath, args: ["-e", "console.error('bad');process.exit(2)"], cwd, timeoutMs: 2_000 }
    ]);
    expect(results.map((result) => result.ok)).toEqual([true, false]);
    expect(results[1]?.output).toContain("bad");
  });
});
