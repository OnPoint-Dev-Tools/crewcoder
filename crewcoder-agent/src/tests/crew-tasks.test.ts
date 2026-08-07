import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getCrewTasksConfigPath, readCrewTasksConfig, setCrewTasksEnabled } from "../crew-tasks/config.js";
import { runCrewTaskCommand } from "../crew-tasks/cli.js";
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
    expect(out).toContain("Task #1 created");
    const storePath = path.join(getCrewTasksProjectDir(tmp), "tasks.json");
    expect(fs.existsSync(storePath)).toBe(true);
    expect(runCrewTaskCommand("list", [], tmp)).toContain("#1 [pending] Write docs");
  });

  it("attaches agent-created tasks to sessions", async () => {
    setCrewTasksEnabled(true);
    const tool = createCrewTaskTools().find((item) => item.name === "TaskCreate");
    expect(tool).toBeDefined();
    const result = await tool!.execute({ subject: "Plan work", description: "Create a plan" }, { cwd: tmp, mode: "general", sessionId: "session_test", mutationLog: [] });
    expect(result.content[0]?.text).toContain("Task #1 created");
    expect(new CrewTaskStore(tmp).get("1")?.sessionId).toBe("session_test");
    const sessionsPath = path.join(getCrewTasksProjectDir(tmp), "sessions.json");
    expect(fs.readFileSync(sessionsPath, "utf8")).toContain("session_test");
  });
});
