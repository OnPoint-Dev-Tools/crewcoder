import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RightSidebar } from "../components/RightSidebar.js";
import { applyCrewCoderEvent } from "../state/event-reducer.js";
import { createInitialState } from "../state/tui-store.js";
import { stripAnsi } from "../tui/ansi.js";
import { crewCoderTheme } from "../theme/theme.js";

const originalTasksEnabled = process.env.CREWCODER_TASKS_ENABLED;

afterEach(() => {
  if (originalTasksEnabled === undefined) delete process.env.CREWCODER_TASKS_ENABLED;
  else process.env.CREWCODER_TASKS_ENABLED = originalTasksEnabled;
});

describe("RightSidebar", () => {
  it("organizes file changes above active and pending crew tasks", () => {
    process.env.CREWCODER_TASKS_ENABLED = "true";
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-sidebar-"));
    fs.mkdirSync(path.join(cwd, ".crewcoder", "tasks"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".crewcoder", "tasks", "tasks.json"), JSON.stringify({
      tasks: [
        { id: "1", subject: "Completed setup", status: "completed", sessionId: "session_current", updatedAt: 1 },
        { id: "2", subject: "Wire sidebar sections", activeForm: "Wiring sidebar sections", status: "in_progress", owner: "Crew", sessionId: "session_current", updatedAt: 3 },
        { id: "3", subject: "Verify responsive layout", status: "pending", sessionId: "session_current", updatedAt: 2 },
        { id: "4", subject: "Old session task", status: "in_progress", sessionId: "session_old", updatedAt: 4 }
      ]
    }));
    const state = createInitialState();
    state.cwd = cwd;
    state.sessionId = "session_current";
    state.changedFiles = ["src/components/App.ts", "src/components/RightSidebar.ts"];

    const rawLines = new RightSidebar(state).render({ theme: crewCoderTheme, size: { width: 30, height: 18 } });
    const lines = rawLines.map(stripAnsi);
    const rendered = lines.join("\n");

    expect(lines).toHaveLength(18);
    expect(lines.every((line) => line.length === 30)).toBe(true);
    expect(rendered).toContain("MODIFIED FILES 2");
    expect(rendered).toContain("src/components/App.ts");
    expect(rendered).toContain("CREW TASKS — 1/3 completed");
    expect(rendered).toContain("◉ 2. Wiring sidebar sections");
    expect(rendered).toContain("○ 3. Verify responsive");
    expect(rendered).toContain("✓ 1. Completed setup");
    expect(rawLines.join("\n")).toContain("\x1b[9mCompleted setup");
    expect(rendered).not.toContain("✱");
    expect(rendered).not.toContain("Old session task");
    expect(rendered.indexOf("MODIFIED FILES")).toBeLessThan(rendered.indexOf("CREW TASKS"));
    expect(rendered.indexOf("2.")).toBeLessThan(rendered.indexOf("3."));
    expect(rendered.indexOf("3.")).toBeLessThan(rendered.indexOf("1."));
  });

  it("reloads current-session tasks after they are created and started", () => {
    process.env.CREWCODER_TASKS_ENABLED = "true";
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-sidebar-refresh-"));
    const tasksDir = path.join(cwd, ".crewcoder", "tasks");
    const tasksPath = path.join(tasksDir, "tasks.json");
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(tasksPath, JSON.stringify({
      tasks: [{ id: "1", subject: "Stale task", status: "pending", sessionId: "session_old", updatedAt: 1 }]
    }));
    const state = createInitialState();
    state.cwd = cwd;
    state.sessionId = "session_current";
    const sidebar = new RightSidebar(state);

    const before = sidebar.render({ theme: crewCoderTheme, size: { width: 30, height: 18 } }).map(stripAnsi).join("\n");
    expect(before).toContain("CREW TASKS — 0/0 completed");
    expect(before).toContain("No tasks for this session");
    expect(before).not.toContain("Stale task");

    fs.writeFileSync(tasksPath, JSON.stringify({
      tasks: [
        { id: "1", subject: "Stale task", status: "pending", sessionId: "session_old", updatedAt: 1 },
        { id: "2", subject: "Refresh tasks", activeForm: "Refreshing task display", status: "in_progress", sessionId: "session_current", updatedAt: 3 }
      ]
    }));

    const after = sidebar.render({ theme: crewCoderTheme, size: { width: 30, height: 18 } }).map(stripAnsi).join("\n");
    expect(after).toContain("CREW TASKS — 0/1 completed");
    expect(after).toContain("◉ 1. Refreshing task display");
    expect(after).not.toContain("Stale task");
  });

  it("restarts display numbering for each session without changing status order", () => {
    process.env.CREWCODER_TASKS_ENABLED = "true";
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-sidebar-session-numbers-"));
    fs.mkdirSync(path.join(cwd, ".crewcoder", "tasks"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".crewcoder", "tasks", "tasks.json"), JSON.stringify({
      tasks: [
        { id: "11", subject: "Earlier session task", status: "completed", sessionId: "session_old", updatedAt: 1 },
        { id: "12", subject: "First new-session task", status: "pending", sessionId: "session_new", updatedAt: 2 },
        { id: "13", subject: "Second new-session task", activeForm: "Running second task", status: "in_progress", sessionId: "session_new", updatedAt: 3 }
      ]
    }));
    const state = createInitialState();
    state.cwd = cwd;
    state.sessionId = "session_new";

    const rendered = new RightSidebar(state).render({ theme: crewCoderTheme, size: { width: 32, height: 18 } }).map(stripAnsi).join("\n");

    expect(rendered).toContain("◉ 2. Running second task");
    expect(rendered).toContain("○ 1. First new-session task");
    expect(rendered).not.toContain("11.");
    expect(rendered).not.toContain("12.");
    expect(rendered).not.toContain("13.");
    expect(rendered.indexOf("2. Running")).toBeLessThan(rendered.indexOf("1. First"));
  });

  it("shows live crew workers between file changes and crew tasks", () => {
    process.env.CREWCODER_TASKS_ENABLED = "false";
    const state = createInitialState();
    applyCrewCoderEvent(state, { type: "crew_start", workers: ["reviewer", "builder", "tester"] });
    applyCrewCoderEvent(state, { type: "crew_worker_end", worker: "reviewer", index: 0, total: 3, status: "completed", sessionId: "session_reviewer" });
    applyCrewCoderEvent(state, { type: "crew_worker_start", worker: "builder", index: 1, total: 3, sessionId: "session_builder" });

    const sidebar = new RightSidebar(state);
    const running = sidebar.render({ theme: crewCoderTheme, size: { width: 30, height: 18 } }).map(stripAnsi).join("\n");

    expect(running).toContain("AGENTS: builder");
    expect(running).toContain("builder running");
    expect(running).toContain("tester queued");
    expect(running).toContain("reviewer completed");
    expect(running.indexOf("builder running")).toBeLessThan(running.indexOf("tester queued"));
    expect(running.indexOf("tester queued")).toBeLessThan(running.indexOf("reviewer completed"));
    expect(running.indexOf("MODIFIED FILES")).toBeLessThan(running.indexOf("AGENTS:"));

    applyCrewCoderEvent(state, { type: "crew_worker_end", worker: "builder", index: 1, total: 3, status: "failed", sessionId: "session_builder", error: "provider failed" });
    applyCrewCoderEvent(state, { type: "crew_worker_end", worker: "tester", index: 2, total: 3, status: "completed", sessionId: "session_tester" });
    applyCrewCoderEvent(state, { type: "crew_end", total: 3, completed: 2, failed: 1 });
    const completed = sidebar.render({ theme: crewCoderTheme, size: { width: 30, height: 18 } }).map(stripAnsi).join("\n");

    expect(completed).not.toContain("AGENTS:");
    expect(completed).not.toContain("builder failed");
  });

  it("wraps long file paths and task descriptions instead of truncating them", () => {
    process.env.CREWCODER_TASKS_ENABLED = "true";
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-sidebar-wrap-"));
    fs.mkdirSync(path.join(cwd, ".crewcoder", "tasks"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".crewcoder", "tasks", "tasks.json"), JSON.stringify({
      tasks: [{ id: "8", subject: "Verify the responsive sidebar wrapping behavior", status: "pending", sessionId: "session_wrap", updatedAt: 1 }]
    }));
    const state = createInitialState();
    state.cwd = cwd;
    state.sessionId = "session_wrap";
    state.changedFiles = ["src/components/DeeplyNestedSidebarComponent.ts"];

    const lines = new RightSidebar(state).render({ theme: crewCoderTheme, size: { width: 20, height: 20 } }).map(stripAnsi);
    const compact = lines.map((line) => line.trim()).join("").replaceAll(" ", "");

    expect(lines.join("\n")).not.toContain("…");
    expect(compact).toContain("src/components/DeeplyNestedSidebarComponent.ts");
    expect(compact).toContain("Verifytheresponsivesidebarwrappingbehavior");
  });

  it("places safety and focused Live UI status above modified files", () => {
    process.env.CREWCODER_TASKS_ENABLED = "false";
    const state = createInitialState();
    state.safetyPolicies = [
      { extensionId: "safe", policyId: "env", title: "Protect env", action: "block", tools: [], paths: [".env"], commands: [] },
      { extensionId: "safe", policyId: "writes", title: "Review writes", action: "review", tools: ["write"], paths: [], commands: [] }
    ];
    state.liveUiFocus = {
      instanceId: "i1",
      key: "live:review",
      extensionId: "review-pack",
      contributionId: "review-panel",
      surface: "modal",
      title: "review-panel",
      permissions: { ui: ["render", "input"], commands: ["ui_response"] }
    };

    const rendered = new RightSidebar(state).render({ theme: crewCoderTheme, size: { width: 34, height: 24 } }).map(stripAnsi).join("\n");

    expect(rendered).toContain("STATUS 2");
    expect(rendered).toContain("SAFETY  2 · 1 block · 1 review");
    expect(rendered).toContain("LIVE UI  review-panel");
    expect(rendered.replaceAll(/\s+/g, " ")).toContain("render · input · respond");
    expect(rendered.indexOf("STATUS 2")).toBeLessThan(rendered.indexOf("MODIFIED FILES"));
  });

  it("anchors the combined CWD/Git identity and CrewCoder branding at the bottom", () => {
    process.env.CREWCODER_TASKS_ENABLED = "false";
    const state = createInitialState();
    state.cwd = "/workspaces/crewcoder";
    state.gitLabel = "feature/sidebar-polish*";
    state.changedFiles = ["src/components/RightSidebar.ts"];

    const lines = new RightSidebar(state).render({ theme: crewCoderTheme, size: { width: 30, height: 18 } }).map(stripAnsi);
    const modifiedRow = lines.findIndex((line) => line.includes("MODIFIED FILES"));
    const ruleRow = lines.map((line) => line.trim()).lastIndexOf("─".repeat(30));
    const workspaceRow = lines.findIndex((line) => line.includes("/workspaces/crewcoder"));
    const brandRow = lines.findIndex((line) => line.includes("• CrewCoder"));

    expect(modifiedRow).toBe(0);
    expect(ruleRow).toBeLessThan(workspaceRow);
    expect(lines.slice(workspaceRow, brandRow).map((line) => line.trim()).join("")).toContain("/workspaces/crewcoder:feature/sidebar-polish*");
    expect(brandRow).toBe(lines.length - 1);
    expect(lines.every((line) => line.length === 30)).toBe(true);
  });

  it("shows disabled file-change state without discarding tracked paths", () => {
    process.env.CREWCODER_TASKS_ENABLED = "false";
    const state = createInitialState();
    state.changedFiles = ["src/kept.ts"];
    state.showFileChanges = false;

    const rendered = new RightSidebar(state).render({ theme: crewCoderTheme, size: { width: 24, height: 10 } }).map(stripAnsi).join("\n");

    expect(rendered).toContain("MODIFIED FILES off");
    expect(rendered).toContain("Display disabled");
    expect(rendered).not.toContain("src/kept.ts");
    expect(state.changedFiles).toEqual(["src/kept.ts"]);
  });
});
