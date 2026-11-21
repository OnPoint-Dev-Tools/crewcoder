import {
  prioritizedTasks, sessionDisplayNumbers, taskBlocked, taskLabel, tasksForSessions,
  type CrewTaskRecord, type CrewTaskSnapshot
} from "@onpoint-dev-tools/crewcoder-tui-core/state/crew-tasks";
import type { TuiCrewWorker, TuiSafetyPolicy, TuiState } from "@onpoint-dev-tools/crewcoder-tui-core/state/tui-store";
import stringWidth from "string-width";
import { relativePath } from "./tool-presentation.js";
import { normalize } from "./transcript.js";

/**
 * The right sidebar, ported from the legacy `RightSidebar`/`TaskWidget`: safety
 * status, modified files, live crew agents, and crew tasks from the top, and
 * the `<cwd>:<git>` workspace with the brand anchored at the bottom. Pure, so
 * the rows the component draws are exactly the rows tested here.
 */

/** Below this many terminal columns the sidebar is hidden (its open/closed setting is kept). */
export const MIN_SIDEBAR_TERMINAL_WIDTH = 60;
export const MIN_SIDEBAR_WIDTH = 18;
export const MAX_SIDEBAR_WIDTH = 60;
/** The conversation keeps at least this many columns when the divider is dragged. */
export const MIN_MAIN_WIDTH = 32;
/** Left inset of section text; one cell stays free on the right. */
export const SIDEBAR_INSET = 2;

export type SidebarTone =
  | "heading" | "taskHeading" | "count" | "text" | "muted" | "subtle"
  | "success" | "warning" | "error" | "active" | "rule" | "brand";

export type SidebarSpan = { text: string; tone: SidebarTone; bold?: boolean; strike?: boolean };
/** One terminal row. Never wider than the sidebar. */
export type SidebarRow = readonly SidebarSpan[];

export type SidebarState = Pick<
  TuiState,
  "cwd" | "remoteTarget" | "gitLabel" | "changedFiles" | "showFileChanges" | "crewWorkers" | "safetyPolicies" | "sessionId" | "crewSessionIds"
>;

export type SidebarInput = {
  state: SidebarState;
  /** The crew task store; `undefined` where it cannot be read (remote SSH workspaces). */
  tasks: CrewTaskSnapshot | undefined;
  /** Spinner frame for running workers. */
  spinner: string;
  /** Local home directory, shortened to `~` in the footer; omit for remote workspaces. */
  home?: string;
};

/** Sidebar columns for a terminal width; 0 when the terminal is too narrow for one. */
export function sidebarWidth(terminalWidth: number, preferred?: number): number {
  if (terminalWidth < MIN_SIDEBAR_TERMINAL_WIDTH) return 0;
  return clampSidebarWidth(preferred ?? Math.min(36, Math.max(20, Math.floor(terminalWidth * 0.26))), terminalWidth);
}

/** Keep a dragged width inside the sidebar bounds and leave the conversation room. */
export function clampSidebarWidth(width: number, terminalWidth: number): number {
  const maximum = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, terminalWidth - MIN_MAIN_WIDTH - 1));
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(maximum, Math.round(width)));
}

/** Exactly `height` rows (blank rows pad the gap above the footer). */
export function sidebarRows(input: SidebarInput, width: number, height: number): SidebarRow[] {
  if (width <= 0 || height <= 0) return [];
  const footer = workspaceRows(input, width);
  const contentHeight = Math.max(0, height - footer.length);
  const status = statusRows(input.state.safetyPolicies, width);
  const agents = agentRows(input.state.crewWorkers, input.spinner, width, height);
  const fixed: SidebarRow[] = [
    ...(status.length ? [...status, rule(width)] : []),
    ...fileRows(input.state, width, height),
    rule(width),
    ...(agents.length ? [...agents, rule(width)] : [])
  ];
  const taskRows = crewTaskRows(input, width, Math.max(0, contentHeight - fixed.length));
  const content = [...fixed, ...taskRows].slice(0, contentHeight);
  while (content.length < contentHeight) content.push([]);
  return [...content, ...footer].slice(0, height);
}

function statusRows(policies: readonly TuiSafetyPolicy[], width: number): SidebarRow[] {
  if (!policies.length) return [];
  const label = "SAFETY  ";
  const lines = wrapCells(safetySummary(policies), textWidth(width) - label.length);
  return [
    heading("STATUS", "1", width),
    ...lines.map((line, index): SidebarRow => index === 0
      ? [inset(), { text: "SAFETY", tone: "muted", bold: true }, { text: "  ", tone: "muted" }, { text: line, tone: "warning" }]
      : [inset(SIDEBAR_INSET + label.length), { text: line, tone: "warning" }])
  ];
}

function safetySummary(policies: readonly TuiSafetyPolicy[]): string {
  const blocks = policies.filter((policy) => policy.action === "block").length;
  const reviews = policies.filter((policy) => policy.action === "review").length;
  return [String(policies.length), blocks ? `${blocks} block` : "", reviews ? `${reviews} review` : ""].filter(Boolean).join(" · ");
}

/** Newest files last; when they do not all fit, the newest stay and the rest are counted. */
function fileRows(state: SidebarState, width: number, height: number): SidebarRow[] {
  const files = state.changedFiles;
  const rows: SidebarRow[] = [heading("MODIFIED FILES", state.showFileChanges ? String(files.length) : "off", width)];
  if (!state.showFileChanges) return [...rows, ...text("Display disabled", "muted", width), ...text("/file-changes on", "subtle", width)];
  if (!files.length) return [...rows, ...text("✓ No file changes", "success", width)];
  const budget = Math.max(3, Math.min(9, Math.floor(height * 0.3)));
  const shown: SidebarRow[] = [];
  let firstShown = files.length;
  for (let index = files.length - 1; index >= 0; index--) {
    const item = itemRows(relativePath(normalize(files[index] ?? ""), state.cwd), "●", "warning", "text", width);
    // Keep a row for "… N more" while older files remain.
    if (rows.length + shown.length + item.length + (index > 0 ? 1 : 0) > budget) break;
    shown.unshift(...item);
    firstShown = index;
  }
  const more = firstShown > 0 ? text(`… ${firstShown} more`, "muted", width) : [];
  return [...rows, ...shown, ...more];
}

/** Shown only while a crew is live; a finished crew does not linger here. */
function agentRows(workers: readonly TuiCrewWorker[], spinner: string, width: number, height: number): SidebarRow[] {
  if (!workers.some((worker) => worker.status === "running" || worker.status === "pending")) return [];
  const rank: Record<TuiCrewWorker["status"], number> = { running: 0, pending: 1, failed: 2, completed: 3 };
  const ordered = [...workers].sort((left, right) => rank[left.status] - rank[right.status]);
  const running = ordered.filter((worker) => worker.status === "running").map((worker) => normalize(worker.name));
  const budget = Math.max(2, Math.min(8, Math.floor(height * 0.25)));
  const rows: SidebarRow[] = [heading(`AGENTS: ${running.length ? running.join(", ") : "waiting"}`, "", width)];
  let shown = 0;
  for (const [index, worker] of ordered.entries()) {
    const style = WORKER_STYLES[worker.status];
    const item = itemRows(`${normalize(worker.name)} ${style.label}`, worker.status === "running" ? spinner : style.icon, style.tone, "text", width);
    if (rows.length + item.length + (index < ordered.length - 1 ? 1 : 0) > budget) break;
    rows.push(...item);
    shown += 1;
  }
  if (ordered.length > shown) rows.push(...text(`… ${ordered.length - shown} more`, "muted", width));
  return rows;
}

const WORKER_STYLES: Readonly<Record<TuiCrewWorker["status"], { icon: string; tone: SidebarTone; label: string }>> = {
  running: { icon: "", tone: "active", label: "running" },
  pending: { icon: "□", tone: "muted", label: "queued" },
  completed: { icon: "✓", tone: "success", label: "completed" },
  failed: { icon: "✕", tone: "error", label: "failed" }
};

/** Most crew tasks fit; the store is reread by the controller, never here. */
const MAX_VISIBLE_TASKS = 9;

function crewTaskRows(input: SidebarInput, width: number, height: number): SidebarRow[] {
  if (height <= 0) return [];
  if (!input.tasks) return [taskHeading(undefined, width), ...text("Not shown for SSH workspaces", "muted", width)].slice(0, height);
  if (!input.tasks.enabled) return [];
  // Crew workers record tasks under their own sessions; they belong to this one.
  const tasks = tasksForSessions(input.tasks.tasks, [input.state.sessionId, ...input.state.crewSessionIds]);
  const done = tasks.filter((task) => task.status === "completed").length;
  const rows: SidebarRow[] = [taskHeading({ done, total: tasks.length }, width)];
  if (!tasks.length) return [...rows, ...text("No tasks for this session", "muted", width)].slice(0, height);
  const numbers = sessionDisplayNumbers(tasks);
  const candidates = prioritizedTasks(tasks).slice(0, Math.max(3, Math.min(MAX_VISIBLE_TASKS, tasks.length)));
  let shown = 0;
  for (const [index, task] of candidates.entries()) {
    const item = taskRows(task, numbers.get(task.id) ?? 1, width);
    if (rows.length + item.length + (index < tasks.length - 1 ? 1 : 0) > height) break;
    rows.push(...item);
    shown += 1;
  }
  if (tasks.length > shown) rows.push(...text(`… ${tasks.length - shown} more`, "muted", width));
  return rows.slice(0, height);
}

function taskHeading(progress: { done: number; total: number } | undefined, width: number): SidebarRow {
  const full = progress ? ` — ${progress.done}/${progress.total} completed` : "";
  const counts = progress && stringWidth(`CREW TASKS${full}`) > textWidth(width) ? ` ${progress.done}/${progress.total}` : full;
  const label = truncateCells("CREW TASKS", Math.max(1, textWidth(width) - stringWidth(counts)));
  return [inset(), { text: label, tone: "taskHeading", bold: true }, { text: truncateCells(counts, textWidth(width) - stringWidth(label)), tone: "count" }];
}

/** `◉ 2. Writing tests`: active, `○` queued, `!` blocked, `✓` done (struck through). */
function taskRows(task: CrewTaskRecord, number: number, width: number): SidebarRow[] {
  const blocked = taskBlocked(task);
  const completed = task.status === "completed";
  const active = task.status === "in_progress";
  const icon = completed ? "✓" : active ? "◉" : blocked ? "!" : "○";
  const iconTone: SidebarTone = completed ? "success" : active || blocked ? "warning" : "muted";
  const labelTone: SidebarTone = completed ? "muted" : active ? "warning" : "text";
  const prefix = `${icon} ${number}. `;
  const lines = wrapCells(normalize(taskLabel(task)), textWidth(width) - stringWidth(prefix));
  return lines.map((line, index): SidebarRow => index === 0
    ? [inset(), { text: icon, tone: iconTone }, { text: " ", tone: "text" }, { text: `${number}.`, tone: completed ? "subtle" : "warning", bold: true }, { text: " ", tone: "text" }, { text: line, tone: labelTone, bold: active, strike: completed }]
    : [inset(SIDEBAR_INSET + stringWidth(prefix)), { text: line, tone: labelTone, bold: active, strike: completed }]);
}

/** Rule, `<cwd>:<git>` (wrapped, never truncated), a gap, and the brand. */
function workspaceRows(input: SidebarInput, width: number): SidebarRow[] {
  const { cwd, remoteTarget, gitLabel } = input.state;
  const home = input.home;
  const location = remoteTarget
    ? `${remoteTarget}:${cwd}`
    : home && (cwd === home || cwd.startsWith(`${home}/`)) ? `~${cwd.slice(home.length)}` : cwd;
  const workspace = `${normalize(location)}:${gitLabel ? normalize(gitLabel) : "local"}`;
  return [
    rule(width),
    ...text(workspace, gitLabel ? "text" : "muted", width),
    [],
    [inset(), { text: "•", tone: "brand" }, { text: " ", tone: "text" }, { text: "CrewCoder", tone: "text", bold: true }]
  ];
}

function heading(label: string, count: string, width: number): SidebarRow {
  const room = Math.max(1, textWidth(width) - (count ? stringWidth(count) + 1 : 0));
  const row: SidebarSpan[] = [inset(), { text: truncateCells(label, room), tone: "heading", bold: true }];
  return count ? [...row, { text: ` ${count}`, tone: "count" }] : row;
}

/** An icon, then text that wraps under itself. */
function itemRows(value: string, icon: string, iconTone: SidebarTone, tone: SidebarTone, width: number): SidebarRow[] {
  const iconWidth = Math.max(1, stringWidth(icon));
  return wrapCells(value, textWidth(width) - iconWidth - 1).map((line, index): SidebarRow => index === 0
    ? [inset(), { text: icon, tone: iconTone }, { text: " ", tone: "text" }, { text: line, tone }]
    : [inset(SIDEBAR_INSET + iconWidth + 1), { text: line, tone }]);
}

/** Plain section text; wraps, never truncates. */
function text(value: string, tone: SidebarTone, width: number): SidebarRow[] {
  return wrapCells(value, textWidth(width)).map((line): SidebarRow => [inset(), { text: line, tone }]);
}

function rule(width: number): SidebarRow {
  return [{ text: "─".repeat(width), tone: "rule" }];
}

function inset(cells = SIDEBAR_INSET): SidebarSpan {
  return { text: " ".repeat(cells), tone: "text" };
}

function textWidth(width: number): number {
  return Math.max(1, width - SIDEBAR_INSET - 1);
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Word-wrap to `width` terminal cells (wide characters count twice); words
 * longer than a row, such as paths, break between graphemes.
 */
export function wrapCells(value: string, width: number): string[] {
  const columns = Math.max(1, Math.floor(width));
  const lines: string[] = [];
  for (const logical of value.split("\n")) {
    let line = "";
    for (const word of logical.split(/\s+/).filter(Boolean)) {
      if (line && stringWidth(line) + 1 + stringWidth(word) <= columns) {
        line = `${line} ${word}`;
        continue;
      }
      if (line) lines.push(line);
      line = "";
      for (const { segment } of graphemes.segment(word)) {
        if (line && stringWidth(line) + stringWidth(segment) > columns) {
          lines.push(line);
          line = "";
        }
        line += segment;
      }
    }
    lines.push(line);
  }
  return lines;
}

/** Cut to `width` cells with a trailing `…`. */
export function truncateCells(value: string, width: number): string {
  if (stringWidth(value) <= width) return value;
  if (width <= 0) return "";
  let out = "";
  for (const { segment } of graphemes.segment(value)) {
    if (stringWidth(out) + stringWidth(segment) + 1 > width) break;
    out += segment;
  }
  return `${out}…`;
}
