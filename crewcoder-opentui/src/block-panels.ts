import type { TuiEventBlock, TuiGoal } from "@onpoint-dev-tools/crewcoder-tui-core/state/tui-store";
import { normalize } from "./transcript.js";

/**
 * Structured transcript blocks that render as a status panel: crews, goals,
 * review summaries, `/why` answers, background jobs, plugin validation, and
 * checkpoints. Pure, so every view is tested without a renderer; the panel
 * component (`Transcript.tsx`) only draws what this returns.
 */
export type PanelBlock = Extract<TuiEventBlock, {
  type: "crew" | "goal" | "review_summary" | "why" | "background_job" | "validation" | "checkpoint" | "checkpoint_diff";
}>;

/** Theme roles a panel may use; the component maps them to theme colors. */
export type PanelTone = "primary" | "success" | "warning" | "error" | "info" | "muted" | "text";

/** One row. `marker` sits in its own column so wrapped text stays indented under the text. */
export type PanelLine = { text: string; tone: PanelTone; marker?: PanelMarker };
/** A fixed glyph, or `spinner` for something still running. */
export type PanelMarker = { glyph: string; tone: PanelTone } | "spinner";

export type BlockPanel = {
  title: string;
  /** Border and title color: the block's status. */
  tone: PanelTone;
  /** Still changing: the title shows a spinner. */
  live: boolean;
  /** Muted text after the title (ids, counts, branch). */
  meta?: string;
  lines: PanelLine[];
};

/** Changed files listed before `… N more`; legacy's bound. */
export const REVIEW_FILE_LIMIT = 8;
/** Issue references listed before `… N more`; legacy's bound. */
export const REVIEW_ISSUE_LIMIT = 6;
/** Background job output shows its newest lines, like a terminal tail. */
export const BACKGROUND_OUTPUT_LINES = 8;

const PANEL_TYPES: ReadonlySet<TuiEventBlock["type"]> = new Set<PanelBlock["type"]>([
  "crew", "goal", "review_summary", "why", "background_job", "validation", "checkpoint", "checkpoint_diff"
]);

export function isPanelBlock(block: TuiEventBlock): block is PanelBlock {
  return PANEL_TYPES.has(block.type);
}

export function blockPanel(block: PanelBlock): BlockPanel {
  switch (block.type) {
    case "crew": return crewPanel(block);
    case "goal": return goalPanel(block.goal);
    case "review_summary": return reviewPanel(block);
    case "why": return whyPanel(block);
    case "background_job": return backgroundJobPanel(block);
    case "validation": return validationPanel(block);
    case "checkpoint": return checkpointPanel(block);
    case "checkpoint_diff": return checkpointDiffPanel(block);
  }
}

function line(text: string, tone: PanelTone, marker?: PanelMarker): PanelLine {
  return marker ? { text: normalize(text), tone, marker } : { text: normalize(text), tone };
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

const WORKER_MARKERS: Readonly<Record<"pending" | "completed" | "failed", { glyph: string; tone: PanelTone }>> = {
  pending: { glyph: "○", tone: "muted" },
  completed: { glyph: "✓", tone: "success" },
  failed: { glyph: "✗", tone: "error" }
};

function crewPanel(block: Extract<PanelBlock, { type: "crew" }>): BlockPanel {
  const active = block.workers.filter((worker) => worker.status === "running").length;
  const failed = block.workers.filter((worker) => worker.status === "failed").length;
  const title = !block.completed ? "Crew running" : failed ? "Crew finished with failures" : "Crew complete";
  const lines = block.workers.flatMap((worker) => {
    const marker = worker.status === "running" ? "spinner" : WORKER_MARKERS[worker.status];
    const tone: PanelTone = worker.status === "failed" ? "error" : worker.status === "pending" ? "muted" : "text";
    const rows = [line(worker.name, tone, marker)];
    if (worker.error) rows.push(line(worker.error, "error", { glyph: " ", tone: "muted" }));
    return rows;
  });
  return {
    title,
    tone: failed ? "error" : block.completed ? "success" : "primary",
    live: !block.completed,
    meta: [plural(block.workers.length, "agent"), active ? `${active} active` : ""].filter(Boolean).join(" · "),
    lines: lines.length ? lines : [line("No workers", "muted")]
  };
}

const GOAL_TONES: Readonly<Record<TuiGoal["status"], PanelTone>> = {
  queued: "primary",
  running: "primary",
  awaiting_approval: "warning",
  paused: "warning",
  completed: "success",
  failed: "error",
  cancelled: "error"
};

function goalPanel(goal: TuiGoal): BlockPanel {
  const lines = [line(goal.objective, "text")];
  lines.push(line(`maker ${goal.provider}/${goal.model}`, "muted"));
  if (goal.checkModel) {
    lines.push(line(`verifier ${goal.provider}/${goal.checkModel}${goal.timeoutMinutes ? ` · timeout ${goal.timeoutMinutes}m` : ""}`, "info"));
  }
  if (goal.lastCheck) {
    const { verdict, reason, model } = goal.lastCheck;
    lines.push(line(`Last check (${model}): ${verdict} — ${reason}`, verdict === "complete" ? "success" : "warning"));
  }
  if (goal.pendingApproval) {
    lines.push(line(`Needs approval for ${goal.pendingApproval.toolName}: ${goal.pendingApproval.reason}`, "warning", { glyph: "⚠", tone: "warning" }));
    lines.push(line("/goal approve or /goal deny", "muted"));
  }
  if (goal.pauseReason) lines.push(line(`Paused: ${goal.pauseReason}`, "warning"));
  if (goal.error) lines.push(line(goal.error, "error"));
  if (goal.completionSummary) lines.push(line(goal.completionSummary, "success"));
  if (goal.completionEvidence) lines.push(line(`Evidence: ${goal.completionEvidence}`, "muted"));
  const turns = goal.maxTurns ? `${goal.cycle}/${goal.maxTurns}` : String(goal.cycle);
  return {
    title: `Goal · ${goal.status.replace(/_/g, " ")}`,
    tone: GOAL_TONES[goal.status],
    live: goal.status === "running" || goal.status === "queued",
    meta: `${goal.id} · turn ${turns}`,
    lines
  };
}

/** `… N more` under a bounded list, or nothing. */
function moreLine(total: number, shown: number): PanelLine[] {
  return total > shown ? [line(`… ${total - shown} more`, "muted")] : [];
}

function reviewPanel(block: Extract<PanelBlock, { type: "review_summary" }>): BlockPanel {
  const { branch, clean, changedFiles, issueReferences } = block.summary;
  const lines: PanelLine[] = [];
  if (changedFiles.length) {
    lines.push(line("Changed files", "success"));
    for (const file of changedFiles.slice(0, REVIEW_FILE_LIMIT)) lines.push(line(file, "text", { glyph: "•", tone: "success" }));
    lines.push(...moreLine(changedFiles.length, REVIEW_FILE_LIMIT));
  }
  if (issueReferences.length) {
    lines.push(line("Issues", "info"));
    for (const issue of issueReferences.slice(0, REVIEW_ISSUE_LIMIT)) {
      lines.push(line(`${issue.text} (${issue.source})${issue.url ? ` ${issue.url}` : ""}`, "text", { glyph: "#", tone: "info" }));
    }
    lines.push(...moreLine(issueReferences.length, REVIEW_ISSUE_LIMIT));
  } else {
    lines.push(line("No issue references found in the branch, recent commits, or git status.", "muted"));
  }
  return {
    title: "Review summary",
    tone: clean ? "success" : "warning",
    live: false,
    meta: `${branch ?? "(no branch)"} · ${clean ? "clean" : `${plural(changedFiles.length, "changed file")}`}`,
    lines
  };
}

/**
 * `/why`. A transcript readout is a deterministic fallback, not the model's
 * reasoning: its title and color must never match a real explanation, and the
 * reason the model was not used stays visible.
 */
function whyPanel(block: Extract<PanelBlock, { type: "why" }>): BlockPanel {
  const { explanation, source, fallbackReason, toolCalls, changedFiles } = block.decision;
  const fromModel = source === "model";
  const lines: PanelLine[] = [];
  if (fallbackReason) lines.push(line(`The model explainer was not used: ${fallbackReason}`, "warning"));
  lines.push(line(explanation, "text"));
  if (toolCalls.length) lines.push(line(`Tools: ${toolCalls.join(", ")}`, "muted"));
  if (changedFiles.length) lines.push(line(`Files: ${changedFiles.join(", ")}`, "muted"));
  return {
    title: fromModel ? "Why · model explanation" : "Why · transcript readout",
    tone: fromModel ? "info" : "warning",
    live: false,
    lines
  };
}

const JOB_TONES: Readonly<Record<Extract<PanelBlock, { type: "background_job" }>["status"], PanelTone>> = {
  running: "warning",
  completed: "success",
  failed: "error",
  stopped: "error"
};

function backgroundJobPanel(block: Extract<PanelBlock, { type: "background_job" }>): BlockPanel {
  const output = normalize(block.output).replace(/\n+$/, "");
  const all = output ? output.split("\n") : [];
  const tail = all.slice(-BACKGROUND_OUTPUT_LINES);
  const lines = [line(block.command, "text", { glyph: "$", tone: "primary" })];
  if (all.length > tail.length) lines.push(line(`… ${plural(all.length - tail.length, "earlier line")}`, "muted"));
  for (const text of tail) lines.push({ text, tone: "muted", marker: { glyph: "│", tone: "muted" } });
  if (!all.length) lines.push(line(block.status === "running" ? "(waiting for output)" : "(no output)", "muted"));
  const exit = block.exitCode === undefined ? "" : ` · exit ${String(block.exitCode)}`;
  return {
    title: `Background job · ${block.status}`,
    tone: JOB_TONES[block.status],
    live: block.status === "running",
    meta: `${block.bgId}${exit}`,
    lines
  };
}

function validationPanel(block: Extract<PanelBlock, { type: "validation" }>): BlockPanel {
  const lines = [
    ...(block.errors ?? []).map((error) => line(error, "text", { glyph: "✗", tone: "error" })),
    ...(block.warnings ?? []).map((warning) => line(warning, "text", { glyph: "⚠", tone: "warning" }))
  ];
  return {
    title: `Validation · ${block.status}`,
    tone: block.status === "failed" ? "error" : block.status === "passed" ? "success" : "warning",
    live: block.status === "running",
    meta: normalize(block.target),
    lines
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function checkpointPanel(block: Extract<PanelBlock, { type: "checkpoint" }>): BlockPanel {
  const before = block.toolName ? `before ${block.toolName} · ` : "";
  const lines = [line(`${before}${plural(block.fileCount, "file")} · ${formatBytes(block.totalBytes)}${block.truncated ? " · truncated" : ""}`, "muted")];
  lines.push(line(`/rewind ${block.checkpointId} · ${block.reason}`, "muted"));
  return { title: "Checkpoint", tone: "info", live: false, meta: block.checkpointId, lines };
}

/** Unified, like inline edit diffs (side-by-side is not planned). */
function checkpointDiffPanel(block: Extract<PanelBlock, { type: "checkpoint_diff" }>): BlockPanel {
  const lines = block.lines.map((text) => line(text, text.startsWith("+") ? "success" : text.startsWith("-") ? "error" : "muted"));
  if (block.truncated) lines.push(line("(truncated)", "muted"));
  return { title: "Checkpoint diff", tone: "info", live: false, meta: `${normalize(block.path)} · ${block.checkpointId}`, lines };
}
