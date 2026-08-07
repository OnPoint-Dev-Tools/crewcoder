import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Component, RenderContext } from "../tui/component.js";
import type { TuiState } from "../state/tui-store.js";
import { bold, fg, reset, strikethrough } from "../tui/ansi.js";
import { padRight, truncate, wrapText } from "../tui/layout.js";

export type CrewTaskStatus = "pending" | "in_progress" | "completed";

export type CrewTaskRecord = {
  id: string;
  subject: string;
  status: CrewTaskStatus;
  owner?: string;
  sessionId?: string;
  activeForm?: string;
  blockedBy?: string[];
  updatedAt?: number;
};

type TaskStoreFile = { tasks?: CrewTaskRecord[] };
type TaskConfigFile = { enabled?: boolean; maxVisible?: number };

type TaskWidgetSnapshot = {
  enabled: boolean;
  tasks: CrewTaskRecord[];
};

const DEFAULT_MAX_VISIBLE = 9;
const SECTION_INSET = 2;

export class TaskWidget implements Component {
  constructor(private readonly state: TuiState) {}

  desiredHeight(width: number): number {
    const snapshot = readSnapshot(this.state.cwd);
    if (!snapshot.enabled) return 0;
    const tasks = tasksForSession(snapshot.tasks, this.state.sessionId);
    if (!tasks.length) return 2;
    const displayNumbers = sessionDisplayNumbers(tasks);
    const taskRows = visibleTasks(tasks)
      .slice(0, maxVisible(tasks))
      .reduce((rows, task) => rows + taskLineCount(task, displayNumbers.get(task.id) ?? 1, width), 0);
    const extra = tasks.length > maxVisible(tasks) ? 1 : 0;
    return Math.min(13, 1 + taskRows + extra);
  }

  render(ctx: RenderContext): string[] {
    const snapshot = readSnapshot(this.state.cwd);
    if (!snapshot.enabled || ctx.size.height <= 0) return [];

    const tasks = tasksForSession(snapshot.tasks, this.state.sessionId);
    const done = tasks.filter((task) => task.status === "completed").length;
    const displayNumbers = sessionDisplayNumbers(tasks);
    const candidates = visibleTasks(tasks).slice(0, maxVisible(tasks));

    const lines: string[] = [sectionHeading(done, tasks.length, ctx)];
    if (!tasks.length) {
      lines.push(padRight(`${" ".repeat(SECTION_INSET)}${fg(ctx.theme.muted)}No tasks for this session${reset()}`, ctx.size.width));
      return lines.slice(0, ctx.size.height);
    }

    let visibleTasksCount = 0;
    for (const task of candidates) {
      const taskLines = renderTaskLines(task, displayNumbers.get(task.id) ?? 1, ctx);
      if (lines.length + taskLines.length > ctx.size.height) break;
      lines.push(...taskLines);
      visibleTasksCount += 1;
    }
    const hidden = Math.max(0, tasks.length - visibleTasksCount);
    if (hidden > 0 && lines.length < ctx.size.height) {
      lines.push(padRight(`${" ".repeat(SECTION_INSET)}${fg(ctx.theme.muted)}… ${hidden} more${reset()}`, ctx.size.width));
    }
    return lines.slice(0, ctx.size.height);
  }
}

function sectionHeading(done: number, total: number, ctx: RenderContext): string {
  const fullProgress = ` — ${done}/${total} completed`;
  const compactProgress = ` ${done}/${total}`;
  const progress = ctx.size.width >= 28 ? fullProgress : compactProgress;
  const labelWidth = Math.max(1, ctx.size.width - SECTION_INSET - progress.length);
  return padRight(`${" ".repeat(SECTION_INSET)}${fg(ctx.theme.warning)}${bold()}${truncate("CREW TASKS", labelWidth)}${reset()}${fg(ctx.theme.muted)}${progress}${reset()}`, ctx.size.width);
}

function renderTaskLines(task: CrewTaskRecord, displayNumber: number, ctx: RenderContext): string[] {
  const blocked = task.status === "pending" && Boolean(task.blockedBy?.length);
  const icon = task.status === "completed" ? "✓" : task.status === "in_progress" ? "◉" : blocked ? "!" : "○";
  const iconColor = task.status === "completed" ? ctx.theme.success : task.status === "in_progress" || blocked ? ctx.theme.warning : ctx.theme.muted;
  const numberColor = task.status === "completed" ? ctx.theme.subtle : ctx.theme.warning;
  const subjectColor = task.status === "completed" ? ctx.theme.muted : task.status === "in_progress" ? ctx.theme.warning : ctx.theme.text;
  const subjectStyle = task.status === "completed" ? strikethrough() : task.status === "in_progress" ? bold() : "";
  const prefix = `${icon} ${displayNumber}. `;
  const subjectWidth = Math.max(1, ctx.size.width - SECTION_INSET - prefix.length);
  const label = task.status === "in_progress" && task.activeForm?.trim() ? task.activeForm.trim() : task.subject;
  const wrapped = wrapText(label, subjectWidth);
  return wrapped.map((line, index) => padRight(index === 0
    ? `${" ".repeat(SECTION_INSET)}${fg(iconColor)}${icon}${reset()} ${fg(numberColor)}${bold()}${displayNumber}.${reset()} ${fg(subjectColor)}${subjectStyle}${line}${reset()}`
    : `${" ".repeat(SECTION_INSET + prefix.length)}${fg(subjectColor)}${subjectStyle}${line}${reset()}`, ctx.size.width));
}

function taskLineCount(task: CrewTaskRecord, displayNumber: number, width: number): number {
  const prefixLength = `${displayNumber}. `.length + 2;
  const label = task.status === "in_progress" && task.activeForm?.trim() ? task.activeForm.trim() : task.subject;
  return wrapText(label, Math.max(1, width - SECTION_INSET - prefixLength)).length;
}

function tasksForSession(tasks: CrewTaskRecord[], sessionId: string): CrewTaskRecord[] {
  if (!sessionId || sessionId === "new") return [];
  return tasks.filter((task) => task.sessionId === sessionId);
}

function sessionDisplayNumbers(tasks: CrewTaskRecord[]): Map<string, number> {
  const creationOrder = [...tasks].sort((left, right) => {
    const leftId = Number(left.id);
    const rightId = Number(right.id);
    if (Number.isFinite(leftId) && Number.isFinite(rightId)) return leftId - rightId;
    return left.id.localeCompare(right.id);
  });
  return new Map(creationOrder.map((task, index) => [task.id, index + 1]));
}

function visibleTasks(tasks: CrewTaskRecord[]): CrewTaskRecord[] {
  const rank: Record<CrewTaskStatus, number> = { in_progress: 0, pending: 1, completed: 2 };
  return [...tasks].sort((a, b) => rank[a.status] - rank[b.status] || (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || Number(b.id) - Number(a.id));
}

function maxVisible(tasks: CrewTaskRecord[]): number {
  return Math.max(3, Math.min(DEFAULT_MAX_VISIBLE, tasks.length || DEFAULT_MAX_VISIBLE));
}

function readSnapshot(cwd: string): TaskWidgetSnapshot {
  const enabled = readConfig().enabled === true;
  if (!enabled) return { enabled: false, tasks: [] };
  const storePath = path.join(path.resolve(cwd), ".crewcoder", "tasks", "tasks.json");
  try {
    const data = JSON.parse(fs.readFileSync(storePath, "utf8")) as TaskStoreFile;
    return { enabled, tasks: Array.isArray(data.tasks) ? data.tasks.filter(isTaskRecord) : [] };
  } catch {
    return { enabled, tasks: [] };
  }
}

function readConfig(): TaskConfigFile {
  const instanceOverride = process.env.CREWCODER_TASKS_ENABLED?.trim().toLowerCase();
  if (instanceOverride === "true" || instanceOverride === "1" || instanceOverride === "on") return { enabled: true };
  if (instanceOverride === "false" || instanceOverride === "0" || instanceOverride === "off") return { enabled: false };
  const root = process.env.CREWCODER_HOME?.trim() || path.join(os.homedir(), ".crewcoder");
  try {
    return JSON.parse(fs.readFileSync(path.join(path.resolve(root), "tasks", "config.json"), "utf8")) as TaskConfigFile;
  } catch {
    return { enabled: false };
  }
}

function isTaskRecord(value: unknown): value is CrewTaskRecord {
  if (!value || typeof value !== "object") return false;
  const task = value as Partial<CrewTaskRecord>;
  return typeof task.id === "string" && typeof task.subject === "string" && (task.status === "pending" || task.status === "in_progress" || task.status === "completed");
}
