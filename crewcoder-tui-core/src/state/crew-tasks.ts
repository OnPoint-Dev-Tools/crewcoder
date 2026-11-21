import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Read-only view of the agent's crew task store for the TUI sidebars. The
 * agent owns the store (`crewcoder-agent/src/crew-tasks`); this only mirrors
 * its file locations and the fields the sidebar shows.
 */
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

export type CrewTaskSnapshot = {
  /** Tasks are on for this instance (the `CREWCODER_TASKS_ENABLED` override wins over the shared config). */
  enabled: boolean;
  tasks: CrewTaskRecord[];
};

export const DISABLED_TASKS: CrewTaskSnapshot = { enabled: false, tasks: [] };

/** Synchronous read, for renderers that draw on a timer (legacy UI). */
export function readCrewTaskSnapshotSync(cwd: string): CrewTaskSnapshot {
  if (!crewTasksEnabled(readFileSync(configPath()))) return DISABLED_TASKS;
  return { enabled: true, tasks: parseTasks(readFileSync(storePath(cwd))) };
}

export async function readCrewTaskSnapshot(cwd: string): Promise<CrewTaskSnapshot> {
  if (!crewTasksEnabled(await readFile(configPath()))) return DISABLED_TASKS;
  return { enabled: true, tasks: parseTasks(await readFile(storePath(cwd))) };
}

/** This session's tasks; a session that has not started yet has none. */
export function tasksForSession(tasks: readonly CrewTaskRecord[], sessionId: string): CrewTaskRecord[] {
  return tasksForSessions(tasks, [sessionId]);
}

/**
 * Tasks from any of these sessions: the UI session plus the sessions its crew workers
 * ran in (each worker records tasks under its own session id).
 */
export function tasksForSessions(tasks: readonly CrewTaskRecord[], sessionIds: readonly string[]): CrewTaskRecord[] {
  const ids = new Set(sessionIds.filter((id) => id && id !== "new"));
  if (!ids.size) return [];
  return tasks.filter((task) => task.sessionId !== undefined && ids.has(task.sessionId));
}

/**
 * Session-local labels `1, 2, 3…` in creation (id) order. They stay stable when
 * the list is sorted by status; tools keep using the project-wide durable ids.
 */
export function sessionDisplayNumbers(tasks: readonly CrewTaskRecord[]): Map<string, number> {
  const creationOrder = [...tasks].sort((left, right) => {
    const leftId = Number(left.id);
    const rightId = Number(right.id);
    if (Number.isFinite(leftId) && Number.isFinite(rightId) && leftId !== rightId) return leftId - rightId;
    return left.id.localeCompare(right.id);
  });
  return new Map(creationOrder.map((task, index) => [task.id, index + 1]));
}

/** Active first, then queued, then completed; most recently updated first within each. */
export function prioritizedTasks(tasks: readonly CrewTaskRecord[]): CrewTaskRecord[] {
  const rank: Record<CrewTaskStatus, number> = { in_progress: 0, pending: 1, completed: 2 };
  return [...tasks].sort((a, b) => rank[a.status] - rank[b.status] || (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || Number(b.id) - Number(a.id));
}

/** In-progress tasks read as their `activeForm` when they have one. */
export function taskLabel(task: CrewTaskRecord): string {
  return task.status === "in_progress" && task.activeForm?.trim() ? task.activeForm.trim() : task.subject;
}

/** Pending with open dependencies. */
export function taskBlocked(task: CrewTaskRecord): boolean {
  return task.status === "pending" && Boolean(task.blockedBy?.length);
}

function crewTasksEnabled(configText: string | undefined): boolean {
  const instanceOverride = process.env.CREWCODER_TASKS_ENABLED?.trim().toLowerCase();
  if (instanceOverride === "true" || instanceOverride === "1" || instanceOverride === "on") return true;
  if (instanceOverride === "false" || instanceOverride === "0" || instanceOverride === "off") return false;
  if (configText === undefined) return false;
  try {
    return (JSON.parse(configText) as { enabled?: unknown }).enabled === true;
  } catch {
    return false;
  }
}

function parseTasks(text: string | undefined): CrewTaskRecord[] {
  if (text === undefined) return [];
  try {
    const data = JSON.parse(text) as { tasks?: unknown };
    return Array.isArray(data.tasks) ? data.tasks.filter(isTaskRecord) : [];
  } catch {
    return [];
  }
}

function configPath(): string {
  const root = process.env.CREWCODER_HOME?.trim() || path.join(os.homedir(), ".crewcoder");
  return path.join(path.resolve(root), "tasks", "config.json");
}

function storePath(cwd: string): string {
  return path.join(path.resolve(cwd), ".crewcoder", "tasks", "tasks.json");
}

function readFileSync(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

async function readFile(file: string): Promise<string | undefined> {
  try {
    return await fsp.readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

function isTaskRecord(value: unknown): value is CrewTaskRecord {
  if (!value || typeof value !== "object") return false;
  const task = value as Partial<CrewTaskRecord>;
  return typeof task.id === "string" && typeof task.subject === "string" && (task.status === "pending" || task.status === "in_progress" || task.status === "completed");
}
