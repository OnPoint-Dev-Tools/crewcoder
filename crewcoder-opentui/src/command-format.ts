import type { TuiDecisionExplanation, TuiGoal, TuiReviewSummary } from "@onpoint-dev-tools/crewcoder-tui-core/state/tui-store";
import type { FooterAlert } from "./alert-model.js";

/** Pure formatting of structured command results into alert text. */

export function goalLines(goal: TuiGoal): string[] {
  const turns = goal.maxTurns ? `${goal.cycle}/${goal.maxTurns}` : String(goal.cycle);
  const lines = [
    `${goal.id} · ${goal.status.replace("_", " ")} · turn ${turns} · ${goal.provider}/${goal.model}`,
    `  ${goal.objective}`
  ];
  if (goal.pendingApproval) lines.push(`  needs approval: ${goal.pendingApproval.toolName} (${goal.pendingApproval.reason}) — /goal approve or /goal deny`);
  if (goal.lastCheck) lines.push(`  last check (${goal.lastCheck.model}): ${goal.lastCheck.verdict} — ${goal.lastCheck.reason}`);
  if (goal.pauseReason) lines.push(`  paused: ${goal.pauseReason}`);
  if (goal.error) lines.push(`  error: ${goal.error}`);
  if (goal.completionSummary) lines.push(`  done: ${goal.completionSummary}`);
  return lines;
}

export function goalsAlert(goals: readonly TuiGoal[]): FooterAlert {
  if (!goals.length) return { variant: "info", title: "No goal found in this workspace", body: "Start one with /goal <objective>." };
  const attention = goals.some((goal) => goal.status === "failed" || goal.status === "awaiting_approval");
  return {
    variant: attention ? "warning" : "info",
    title: goals.length === 1 ? "Goal" : `Goals (${goals.length})`,
    body: goals.flatMap(goalLines).join("\n")
  };
}

/**
 * `/why`. The badge keeps a real model explanation visibly distinct from the
 * deterministic transcript readout the backend falls back to.
 */
export function whyAlert(decision: TuiDecisionExplanation): FooterAlert {
  const lines = [decision.explanation];
  if (decision.toolCalls.length) lines.push("", `Tools: ${decision.toolCalls.join(", ")}`);
  if (decision.changedFiles.length) lines.push(`Files: ${decision.changedFiles.join(", ")}`);
  if (decision.fallbackReason) lines.push("", `Fallback: ${decision.fallbackReason}`);
  return {
    variant: decision.source === "model" ? "info" : "warning",
    title: decision.source === "model" ? "Why · model explanation" : "Why · transcript readout",
    body: lines.join("\n")
  };
}

export function reviewSummaryAlert(summary: TuiReviewSummary): FooterAlert {
  const lines = [
    `Branch: ${summary.branch ?? "(detached)"} · ${summary.clean ? "clean" : `${summary.changedFiles.length} changed`}`,
    ...summary.changedFiles.map((file) => `  ${file}`)
  ];
  if (summary.issueReferences.length) {
    lines.push("Issues:", ...summary.issueReferences.map((ref) => `  ${ref.id} (${ref.source}) ${ref.text}${ref.url ? ` ${ref.url}` : ""}`));
  }
  return { variant: "info", title: "Review summary", body: lines.join("\n") };
}

/** Text output of a one-shot CLI command; stderr turns it into an error. */
export function cliOutputAlert(title: string, result: { stdout: string; stderr: string; exitCode: number }): FooterAlert {
  if (result.exitCode !== 0) {
    return { variant: "error", title, body: result.stderr.trim() || result.stdout.trim() || `Exited with code ${result.exitCode}.` };
  }
  const body = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
  return { variant: "info", title, body: body || "(no output)" };
}
