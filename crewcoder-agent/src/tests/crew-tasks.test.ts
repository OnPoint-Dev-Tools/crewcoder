import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getCrewTasksConfigPath, readCrewTasksConfig, setCrewTasksEnabled, writeCrewTasksConfig } from "../crew-tasks/config.js";
import { runCrewTaskCommand } from "../crew-tasks/cli.js";
import { crewTaskTodoSnapshot } from "../crew-tasks/snapshot.js";
import { CrewTaskStore, getCrewTasksProjectDir } from "../crew-tasks/store.js";
import { createCrewTaskTools } from "../crew-tasks/tools.js";

let tmp: string;
let oldHome: string | undefined;
let oldTasksEnabled: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "crew-tasks-"));
  oldHome = process.env.CREWCODER_HOME;
  oldTasksEnabled = process.env.CREWCODER_TASKS_ENABLED;
  delete process.env.CREWCODER_TASKS_ENABLED;
  process.env.CREWCODER_HOME = path.join(tmp, "home", ".crewcoder");
});

afterEach(() => {
  if (oldHome === undefined) delete process.env.CREWCODER_HOME;
  else process.env.CREWCODER_HOME = oldHome;
  if (oldTasksEnabled === undefined) delete process.env.CREWCODER_TASKS_ENABLED;
  else process.env.CREWCODER_TASKS_ENABLED = oldTasksEnabled;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("crew-tasks", () => {
  it("is disabled by default and stores config globally", () => {
    expect(readCrewTasksConfig().enabled).toBe(false);
    expect(createCrewTaskTools()).toEqual([]);
    expect(getCrewTasksConfigPath()).toBe(path.join(process.env.CREWCODER_HOME!, "tasks", "config.json"));
  });

  it("toggles with task on/off", () => {
    expect(runCrewTaskCommand("on", [], tmp)).toContain("crew-tasks enabled");
    expect(readCrewTasksConfig().enabled).toBe(true);
    expect(fs.existsSync(getCrewTasksConfigPath())).toBe(true);
    expect(createCrewTaskTools().map((tool) => tool.name)).toContain("TaskCreate");
    expect(runCrewTaskCommand("off", [], tmp)).toContain("crew-tasks disabled");
    expect(readCrewTasksConfig().enabled).toBe(false);
  });

  it("applies a process-local enabled override without rewriting shared config", () => {
    setCrewTasksEnabled(false);
    process.env.CREWCODER_TASKS_ENABLED = "true";
    expect(readCrewTasksConfig().enabled).toBe(true);
    expect(createCrewTaskTools().map((tool) => tool.name)).toContain("TaskCreate");
    delete process.env.CREWCODER_TASKS_ENABLED;
    expect(readCrewTasksConfig().enabled).toBe(false);
  });

  it("stores project tasks under .crewcoder/tasks", () => {
    setCrewTasksEnabled(true);
    const out = runCrewTaskCommand("add", ["Write", "docs"], tmp);
    expect(out).toContain("Created #1: Write docs");
    const storePath = path.join(getCrewTasksProjectDir(tmp), "tasks.json");
    expect(fs.existsSync(storePath)).toBe(true);
    expect(runCrewTaskCommand("list", [], tmp)).toContain("#1 [pending] Write docs");
  });

  it("attaches agent-created tasks to sessions", async () => {
    setCrewTasksEnabled(true);
    const tool = createCrewTaskTools().find((item) => item.name === "TaskCreate");
    expect(tool).toBeDefined();
    const result = await tool!.execute({ subject: "Plan work", description: "Create a plan" }, { cwd: tmp, mode: "general", sessionId: "session_test", mutationLog: [] });
    expect(result.content[0]?.text).toContain("Created #1: Plan work");
    expect(result.details?.todos).toEqual([{ content: "Plan work", status: "pending" }]);
    expect(new CrewTaskStore(tmp).get("1", "session_test")?.sessionId).toBe("session_test");
    const sessionsPath = path.join(getCrewTasksProjectDir(tmp), "sessions.json");
    expect(fs.readFileSync(sessionsPath, "utf8")).toContain("session_test");
  });

  it("syncs a full session todo snapshot after later mutations", async () => {
    setCrewTasksEnabled(true);
    const create = createCrewTaskTools().find((item) => item.name === "TaskCreate");
    const update = createCrewTaskTools().find((item) => item.name === "TaskUpdate");
    const context = { cwd: tmp, mode: "general" as const, sessionId: "session_test", mutationLog: [] };
    await create!.execute({ subject: "Write the parser", description: "parse input", activeForm: "Writing the parser" }, context);
    await create!.execute({ subject: "Add tests", description: "cover the parser" }, context);
    const result = await update!.execute({ taskId: "1", status: "in_progress" }, context);
    expect(result.details?.todos).toEqual([
      { content: "Write the parser", status: "in_progress", activeForm: "Writing the parser" },
      { content: "Add tests", status: "pending" }
    ]);
  });

  it("omits the todo snapshot when autoSyncTodos is off", async () => {
    writeCrewTasksConfig({ ...readCrewTasksConfig(), enabled: true, autoSyncTodos: false });
    const tool = createCrewTaskTools().find((item) => item.name === "TaskCreate");
    const result = await tool!.execute({ subject: "Hidden snapshot", description: "no overlay" }, { cwd: tmp, mode: "general", sessionId: "session_test", mutationLog: [] });
    expect(result.details?.todos).toBeUndefined();
  });

  it("maps tasks onto overlay items by subject, not display numbers", () => {
    expect(crewTaskTodoSnapshot([
      { id: "9", subject: "Ship it", description: "", status: "pending", projectPath: tmp, metadata: {}, blocks: [], blockedBy: [], createdAt: 1, updatedAt: 1 }
    ])).toEqual([{ content: "Ship it", status: "pending" }]);
  });

  it("restarts task ids per agent session instead of rolling the project counter", () => {
    const store = new CrewTaskStore(tmp);
    expect(store.create({ subject: "Old agent", description: "a", sessionId: "session_a" }).id).toBe("1");
    expect(store.create({ subject: "Old agent two", description: "a", sessionId: "session_a" }).id).toBe("2");
    expect(store.create({ subject: "New agent", description: "b", sessionId: "session_b" }).id).toBe("1");
    expect(store.get("1", "session_b")?.subject).toBe("New agent");
    expect(store.get("1", "session_a")?.subject).toBe("Old agent");
  });

  it("resets a session to #1 when a new task is created after the previous list completed", () => {
    const store = new CrewTaskStore(tmp);
    const first = store.create({ subject: "Old plan", description: "a", sessionId: "session_a" });
    expect(first.id).toBe("1");
    store.update("1", { status: "completed" }, "session_a");
    const next = store.create({ subject: "Fresh plan", description: "b", sessionId: "session_a" });
    expect(next.id).toBe("1");
    expect(store.get("1", "session_a")?.subject).toBe("Fresh plan");
    expect(store.list("id", { sessionId: "session_a", includeCompleted: true })).toHaveLength(1);
  });
});
