import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  prioritizedTasks, readCrewTaskSnapshot, readCrewTaskSnapshotSync, sessionDisplayNumbers, taskBlocked, taskLabel, tasksForSession,
  type CrewTaskRecord
} from "../state/crew-tasks.js";

const roots: string[] = [];
let home: string;
let workspace: string;

function tempDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crew-tasks-"));
  roots.push(root);
  return root;
}

function writeConfig(enabled: boolean): void {
  fs.mkdirSync(path.join(home, "tasks"), { recursive: true });
  fs.writeFileSync(path.join(home, "tasks", "config.json"), JSON.stringify({ version: 1, enabled }));
}

function writeStore(tasks: unknown[]): void {
  fs.mkdirSync(path.join(workspace, ".crewcoder", "tasks"), { recursive: true });
  fs.writeFileSync(path.join(workspace, ".crewcoder", "tasks", "tasks.json"), JSON.stringify({ version: 1, nextId: 9, tasks }));
}

const task = (id: string, status: CrewTaskRecord["status"], extra: Partial<CrewTaskRecord> = {}): CrewTaskRecord =>
  ({ id, subject: `task ${id}`, status, sessionId: "s1", ...extra });

beforeEach(() => {
  home = tempDir();
  workspace = tempDir();
  vi.stubEnv("CREWCODER_HOME", home);
  vi.stubEnv("CREWCODER_TASKS_ENABLED", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("reading the task store", () => {
  it("is disabled without a config, and reads nothing", async () => {
    writeStore([task("1", "pending")]);
    expect(await readCrewTaskSnapshot(workspace)).toEqual({ enabled: false, tasks: [] });
    expect(readCrewTaskSnapshotSync(workspace)).toEqual({ enabled: false, tasks: [] });
  });

  it("reads valid records once the shared config turns tasks on, dropping malformed ones", async () => {
    writeConfig(true);
    writeStore([task("1", "pending"), { id: 2, subject: "bad id" }, { id: "3", subject: "x", status: "weird" }, task("4", "completed")]);
    const snapshot = await readCrewTaskSnapshot(workspace);
    expect(snapshot.enabled).toBe(true);
    expect(snapshot.tasks.map((item) => item.id)).toEqual(["1", "4"]);
    expect(readCrewTaskSnapshotSync(workspace)).toEqual(snapshot);
  });

  it("lets the instance override win over the shared config both ways", async () => {
    writeConfig(true);
    vi.stubEnv("CREWCODER_TASKS_ENABLED", "off");
    expect((await readCrewTaskSnapshot(workspace)).enabled).toBe(false);
    writeConfig(false);
    vi.stubEnv("CREWCODER_TASKS_ENABLED", "true");
    expect(await readCrewTaskSnapshot(workspace)).toEqual({ enabled: true, tasks: [] });
  });

  it("treats a corrupt store as empty", async () => {
    writeConfig(true);
    fs.mkdirSync(path.join(workspace, ".crewcoder", "tasks"), { recursive: true });
    fs.writeFileSync(path.join(workspace, ".crewcoder", "tasks", "tasks.json"), "{nope");
    expect(await readCrewTaskSnapshot(workspace)).toEqual({ enabled: true, tasks: [] });
  });
});

describe("task presentation helpers", () => {
  it("filters to the session and shows nothing before the session exists", () => {
    const tasks = [task("1", "pending"), task("2", "pending", { sessionId: "other" })];
    expect(tasksForSession(tasks, "s1").map((item) => item.id)).toEqual(["1"]);
    expect(tasksForSession(tasks, "new")).toEqual([]);
  });

  it("numbers tasks 1..n by creation order, stable under status sorting", () => {
    const tasks = [task("12", "completed"), task("7", "in_progress"), task("30", "pending")];
    expect([...sessionDisplayNumbers(tasks)]).toEqual([["7", 1], ["12", 2], ["30", 3]]);
  });

  it("puts active, then queued, then done first, newest update first within each", () => {
    const tasks = [task("1", "completed", { updatedAt: 9 }), task("2", "pending", { updatedAt: 1 }), task("3", "pending", { updatedAt: 5 }), task("4", "in_progress")];
    expect(prioritizedTasks(tasks).map((item) => item.id)).toEqual(["4", "3", "2", "1"]);
  });

  it("labels active tasks by activeForm and spots blocked ones", () => {
    expect(taskLabel(task("1", "in_progress", { activeForm: " Writing tests " }))).toBe("Writing tests");
    expect(taskLabel(task("1", "pending", { activeForm: "Writing tests" }))).toBe("task 1");
    expect(taskBlocked(task("1", "pending", { blockedBy: ["2"] }))).toBe(true);
    expect(taskBlocked(task("1", "in_progress", { blockedBy: ["2"] }))).toBe(false);
  });
});
