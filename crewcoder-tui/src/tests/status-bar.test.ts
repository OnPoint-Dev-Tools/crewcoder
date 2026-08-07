import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { StatusBar } from "../components/StatusBar.js";
import { readGitLabel } from "../state/git-status.js";
import { createInitialState } from "../state/tui-store.js";
import { stripAnsi } from "../tui/ansi.js";
import { crewCoderTheme } from "../theme/theme.js";

describe("StatusBar", () => {
  it("keeps mode and model out of the header status", () => {
    const state = createInitialState();
    state.worker = "Builder";

    const lines = new StatusBar(state).render({ theme: crewCoderTheme, size: { width: 120, height: 2 } }).map(stripAnsi);

    expect(lines[1]).toHaveLength(120);
    expect(lines.join("\n")).not.toContain("MODE:");
    expect(lines.join("\n")).not.toContain("MODEL:");
    expect(lines.join("\n")).not.toContain("worker:Builder");
  });

  it("leaves workspace and Git details to the right sidebar", () => {
    const state = createInitialState();
    state.gitLabel = "main*";

    const lines = new StatusBar(state).render({ theme: crewCoderTheme, size: { width: 180, height: 2 } }).map(stripAnsi);
    const rendered = lines.join("\n");

    expect(rendered).not.toContain(state.cwd);
    expect(rendered).not.toContain("GIT:");
    expect(rendered).not.toContain("CHANGES:");
    expect(rendered).not.toContain("MODEL:");
    expect(rendered).not.toContain("Ctrl+O expand tools");
  });

  it("keeps runtime and active-agent details out of persistent status", () => {
    const state = createInitialState();
    state.running = true;
    state.crewWorkers = [{ name: "builder", status: "running" }];

    const line = new StatusBar(state).render({ theme: crewCoderTheme, size: { width: 300, height: 1 } }).map(stripAnsi).join("\n");
    expect(line).not.toContain("RUNTIME:");
    expect(line).not.toContain("AGENTS:");
  });

  it("leaves file-change details to the right sidebar", () => {
    const state = createInitialState();
    state.changedFiles = ["src/kept.ts"];
    const rendered = new StatusBar(state).render({ theme: crewCoderTheme, size: { width: 300, height: 1 } }).map(stripAnsi).join("\n");

    expect(rendered).not.toContain("CHANGES:");
    expect(rendered).not.toContain("src/kept.ts");
    expect(state.changedFiles).toEqual(["src/kept.ts"]);
  });


  it("detects Git work trees without inventing a label for other directories", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-git-status-"));
    try {
      expect(readGitLabel(cwd)).toBeUndefined();
      expect(spawnSync("git", ["-C", cwd, "init", "--quiet"]).status).toBe(0);
      fs.writeFileSync(path.join(cwd, "dirty.txt"), "dirty\n", "utf8");

      expect(readGitLabel(cwd)).toMatch(/.+\*$/);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("shows focused live UI permissions in the LIVE-UI pill", () => {
    const state = createInitialState();
    state.liveUiFocus = {
      instanceId: "i1",
      key: "liveui:review-1",
      extensionId: "review-pack",
      contributionId: "review-panel",
      surface: "modal",
      title: "review-panel",
      permissions: { ui: ["render", "input", "focus"], commands: ["ui_response"], storage: "session" }
    };

    const line = new StatusBar(state).render({ theme: crewCoderTheme, size: { width: 300, height: 1 } }).map(stripAnsi).join("\n");

    expect(line).toContain("LIVE-UI:");
    expect(line).toContain("review-panel");
    expect(line).toContain("render");
    expect(line).toContain("input");
    expect(line).toContain("focus");
    expect(line).toContain("commands:ui_response");
    expect(line).toContain("storage:session");
  });

  it("omits the LIVE-UI pill when nothing is focused", () => {
    const state = createInitialState();
    const line = new StatusBar(state).render({ theme: crewCoderTheme, size: { width: 120, height: 1 } }).map(stripAnsi).join("\n");
    expect(line).not.toContain("LIVE-UI:");
  });

  it("renders a focused status-surface frame instead of the LIVE-UI pill", () => {
    const state = createInitialState();
    state.liveUiFocus = {
      instanceId: "i1",
      key: "liveui:status-1",
      extensionId: "status-pack",
      contributionId: "status-panel",
      surface: "status",
      title: "status-panel",
      permissions: { ui: ["render", "input"] }
    };
    state.liveUiFrames = new Map();
    state.liveUiFrames.set("liveui:status-1", ["STATUS LINE ONE", "STATUS LINE TWO"]);

    const lines = new StatusBar(state).render({ theme: crewCoderTheme, size: { width: 120, height: 2 } }).map(stripAnsi);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("STATUS LINE ONE");
    expect(lines[1]).toContain("STATUS LINE TWO");
    expect(lines.join("\n")).not.toContain("LIVE-UI:");
  });

  it("falls back to the LIVE-UI pill when a status surface has no frame", () => {
    const state = createInitialState();
    state.liveUiFocus = {
      instanceId: "i1",
      key: "liveui:status-1",
      extensionId: "status-pack",
      contributionId: "status-panel",
      surface: "status",
      title: "status-panel",
      permissions: { ui: ["render"] }
    };

    const line = new StatusBar(state).render({ theme: crewCoderTheme, size: { width: 300, height: 2 } }).map(stripAnsi).join("\n");

    expect(line).toContain("LIVE-UI:");
    expect(line).toContain("status-panel");
  });
});
