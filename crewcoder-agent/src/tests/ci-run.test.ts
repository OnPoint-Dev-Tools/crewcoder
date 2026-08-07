import { describe, expect, it } from "vitest";
import type { AgentLoopResult } from "../core/agent-loop.js";
import { CI_RUN_EXIT_CODES, createCiErrorSummary, createCiRunSummary } from "../core/ci-run.js";

function runResult(overrides: Partial<AgentLoopResult> = {}): AgentLoopResult {
  return {
    sessionId: "session_ci",
    mode: "general",
    providerId: "test",
    model: "test-model",
    messages: [],
    activatedSkills: [],
    activatedExtensions: [],
    retrievedDocs: [],
    mutationLog: ["src/a.ts", "src/a.ts"],
    usage: { turns: 1, totalTokens: 25 },
    project: { cwd: "/repo", markers: [] },
    compactions: [],
    checkpoints: [],
    modelTurns: [],
    summary: "CrewCoder completed in general mode.",
    notes: [],
    budgetExceeded: false,
    ...overrides
  };
}

describe("CI run summary", () => {
  it("returns a stable success summary and deduplicates changed files", () => {
    const summary = createCiRunSummary(runResult({
      verification: { ok: true, checks: [{ id: "test", title: "Tests", ok: true, output: "ok", durationMs: 10 }] }
    }));

    expect(summary).toMatchObject({
      schemaVersion: 1,
      status: "success",
      success: true,
      exitCode: CI_RUN_EXIT_CODES.success,
      sessionId: "session_ci",
      changedFiles: ["src/a.ts"],
      failure: null
    });
  });

  it.each([
    ["verification_failed", CI_RUN_EXIT_CODES.verificationFailed, { verification: { ok: false, checks: [{ id: "test", title: "Tests", ok: false, output: "failed", durationMs: 10 }] } }],
    ["budget_exceeded", CI_RUN_EXIT_CODES.budgetExceeded, { budgetExceeded: true, usage: { turns: 1, totalTokens: 101, tokenBudget: 100, budgetExceeded: true } }],
    ["approval_denied", CI_RUN_EXIT_CODES.approvalDenied, { approvalDenied: { approvalId: "approval_call", toolName: "write", reason: "policy denied" } }],
    ["failed", CI_RUN_EXIT_CODES.failed, { providerError: "provider unavailable" }]
  ] satisfies Array<[string, number, Partial<AgentLoopResult>]>)("maps %s to exit code %i", (status, exitCode, overrides) => {
    expect(createCiRunSummary(runResult(overrides))).toMatchObject({ status, exitCode, success: false });
  });

  it("uses the terminal stop reason before a verification failure", () => {
    const summary = createCiRunSummary(runResult({
      approvalDenied: { approvalId: "approval_call", reason: "denied" },
      verification: { ok: false, checks: [{ id: "test", title: "Tests", ok: false, output: "failed", durationMs: 10 }] }
    }));

    expect(summary).toMatchObject({ status: "approval_denied", exitCode: CI_RUN_EXIT_CODES.approvalDenied });
  });

  it("keeps provider failures primary when verification also fails", () => {
    const summary = createCiRunSummary(runResult({
      providerError: "provider unavailable",
      verification: { ok: false, checks: [{ id: "test", title: "Tests", ok: false, output: "failed", durationMs: 10 }] }
    }));

    expect(summary).toMatchObject({ status: "failed", exitCode: CI_RUN_EXIT_CODES.failed });
  });

  it("formats setup failures as JSON-compatible exit-code-1 summaries", () => {
    expect(createCiErrorSummary(new Error("bad config"))).toMatchObject({
      status: "failed",
      exitCode: CI_RUN_EXIT_CODES.failed,
      sessionId: null,
      summary: "bad config"
    });
  });
});
