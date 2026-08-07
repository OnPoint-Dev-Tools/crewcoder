import type { AgentLoopResult } from "./agent-loop.js";

export const CI_RUN_EXIT_CODES = {
  success: 0,
  failed: 1,
  verificationFailed: 2,
  budgetExceeded: 3,
  approvalDenied: 4
} as const;

export type CiRunExitCode = typeof CI_RUN_EXIT_CODES[keyof typeof CI_RUN_EXIT_CODES];
export type CiRunStatus = "success" | "failed" | "verification_failed" | "budget_exceeded" | "approval_denied";

export type CiRunSummary = {
  schemaVersion: 1;
  status: CiRunStatus;
  success: boolean;
  exitCode: CiRunExitCode;
  sessionId: string | null;
  mode: AgentLoopResult["mode"] | null;
  provider: string | null;
  model: string | null;
  summary: string;
  changedFiles: string[];
  usage: AgentLoopResult["usage"] | null;
  verification: AgentLoopResult["verification"] | null;
  failure: {
    type: Exclude<CiRunStatus, "success">;
    message: string;
  } | null;
};

export function createCiRunSummary(result: AgentLoopResult): CiRunSummary {
  const outcome = resolveCiRunOutcome(result);
  return {
    schemaVersion: 1,
    status: outcome.status,
    success: outcome.exitCode === CI_RUN_EXIT_CODES.success,
    exitCode: outcome.exitCode,
    sessionId: result.sessionId,
    mode: result.mode,
    provider: result.providerId ?? null,
    model: result.model ?? null,
    summary: result.summary,
    changedFiles: [...new Set(result.mutationLog)],
    usage: result.usage,
    verification: result.verification ?? null,
    failure: outcome.failure
  };
}

export function createCiErrorSummary(error: unknown): CiRunSummary {
  const message = error instanceof Error ? error.message : String(error);
  return {
    schemaVersion: 1,
    status: "failed",
    success: false,
    exitCode: CI_RUN_EXIT_CODES.failed,
    sessionId: null,
    mode: null,
    provider: null,
    model: null,
    summary: message,
    changedFiles: [],
    usage: null,
    verification: null,
    failure: { type: "failed", message }
  };
}

function resolveCiRunOutcome(result: AgentLoopResult): {
  status: CiRunStatus;
  exitCode: CiRunExitCode;
  failure: CiRunSummary["failure"];
} {
  if (result.approvalDenied) {
    const message = result.approvalDenied.reason ?? `Approval denied for ${result.approvalDenied.toolName ?? "tool call"}.`;
    return { status: "approval_denied", exitCode: CI_RUN_EXIT_CODES.approvalDenied, failure: { type: "approval_denied", message } };
  }
  if (result.budgetExceeded) {
    const used = result.usage.totalTokens ?? 0;
    const limit = result.usage.tokenBudget;
    const message = typeof limit === "number" ? `Token budget exceeded (${used}/${limit}).` : "Token budget exceeded.";
    return { status: "budget_exceeded", exitCode: CI_RUN_EXIT_CODES.budgetExceeded, failure: { type: "budget_exceeded", message } };
  }
  const runFailure = result.providerError ?? result.stallError ?? (result.iterationCapReached ? "Run stopped at the configured iteration cap." : undefined);
  if (runFailure) {
    return { status: "failed", exitCode: CI_RUN_EXIT_CODES.failed, failure: { type: "failed", message: runFailure } };
  }
  if (result.verification && !result.verification.ok) {
    const failed = result.verification.checks.filter((check) => !check.ok).map((check) => check.title);
    const message = failed.length ? `Verification failed: ${failed.join(", ")}.` : "Verification failed.";
    return { status: "verification_failed", exitCode: CI_RUN_EXIT_CODES.verificationFailed, failure: { type: "verification_failed", message } };
  }
  return { status: "success", exitCode: CI_RUN_EXIT_CODES.success, failure: null };
}
