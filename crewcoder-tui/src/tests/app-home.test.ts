import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../components/App.js";
import { RightSidebar } from "../components/RightSidebar.js";
import { readGitLabel } from "../state/git-status.js";
import { createInitialState } from "../state/tui-store.js";
import { crewCoderTheme } from "../theme/theme.js";
import { bigCrewCodeLogoLines } from "../theme/logo.js";
import { bg, fg, reset, stripAnsi } from "../tui/ansi.js";

const SIZE = { width: 100, height: 32 };
const originalCrewCoderHome = process.env.CREWCODER_HOME;

afterEach(() => {
  if (originalCrewCoderHome === undefined) delete process.env.CREWCODER_HOME;
  else process.env.CREWCODER_HOME = originalCrewCoderHome;
});

function renderApp(app: App): string[] {
  return app.render({ theme: crewCoderTheme, size: SIZE }).map(stripAnsi);
}

describe("Git status", () => {
  it("renders a real Git label in the right sidebar workspace footer", () => {
    const state = createInitialState();
    state.cwd = "/workspaces/crewcoder";
    const sidebar = new RightSidebar(state);

    const withoutGit = sidebar.render({ theme: crewCoderTheme, size: { width: 64, height: 18 } }).map(stripAnsi).join("\n");
    expect(withoutGit).toContain(`${state.cwd}:local`);

    state.gitLabel = "feature/git-status*";
    const withGit = sidebar.render({ theme: crewCoderTheme, size: { width: 64, height: 18 } }).map(stripAnsi).join("\n");
    expect(withGit).toContain(`${state.cwd}:feature/git-status*`);
  });

  it("detects work trees without inventing labels for other directories", () => {
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
});

describe("App home screen", () => {
  it("shows the centered logo and composer on a fresh session", () => {
    const app = new App(createInitialState());
    const lines = renderApp(app);

    const logoRow = lines.findIndex((line) => line.includes(bigCrewCodeLogoLines[0]!.trim().slice(0, 4)));
    expect(logoRow).toBeGreaterThan(0); // not pinned to the top — vertically centered

    expect(lines.some((line) => line.includes("General »"))).toBe(true); // composer present
    expect(lines.some((line) => line.includes("ctrl+p") && line.includes("commands"))).toBe(true);
    expect(lines.some((line) => line.includes("Tip"))).toBe(true);
    expect(lines.some((line) => line.includes("CHANGES:"))).toBe(false);
  });

  it("centers the logo horizontally", () => {
    const app = new App(createInitialState());
    const lines = renderApp(app);
    const logoLine = lines.find((line) => line.includes(bigCrewCodeLogoLines[0]!.trim().slice(0, 4)))!;

    const leftPad = logoLine.length - logoLine.trimStart().length;
    expect(leftPad).toBeGreaterThan(10);
  });

  it("toggles the command palette with Ctrl+P and the agents overlay with Tab", () => {
    const app = new App(createInitialState());
    const ctrlP = { name: "p", sequence: "", ctrl: true, meta: false, shift: false };
    const tab = { name: "i", sequence: "\t", ctrl: true, meta: false, shift: false };

    // Ctrl+P opens the slash-command palette...
    app.handleInput(ctrlP);
    const commandLines = renderApp(app);
    // Commands are grouped under categorized section headers.
    expect(commandLines.some((line) => line.includes("Session"))).toBe(true);
    expect(commandLines.some((line) => line.includes("Settings"))).toBe(true);
    expect(commandLines.some((line) => line.includes("/new"))).toBe(true);
    expect(commandLines.some((line) => line.includes("/reload"))).toBe(true);
    // ...and pressing it again closes it.
    app.handleInput(ctrlP);
    expect(renderApp(app).some((line) => line.includes("/new"))).toBe(false);

    // Tab opens the agents (mode) overlay...
    app.handleInput(tab);
    expect(renderApp(app).some((line) => line.includes("plugin") || line.includes("Pick mode"))).toBe(true);
    // ...and Tab again closes it.
    app.handleInput(tab);
    expect(renderApp(app).some((line) => line.includes("Pick mode"))).toBe(false);
  });

  it("opens and closes the workspace right sidebar with Ctrl+B", () => {
    const app = new App(createInitialState());
    const ctrlB = { name: "b", sequence: "\u0002", ctrl: true, meta: false, shift: false };

    app.handleInput(ctrlB);
    const openLines = renderApp(app);
    expect(openLines).toHaveLength(SIZE.height);
    expect(openLines.every((line) => line[73] === "│")).toBe(true);
    expect(openLines.join("\n")).toContain("MODIFIED FILES");

    app.handleInput(ctrlB);
    const closedLines = renderApp(app);
    expect(closedLines.some((line) => line[73] !== "│" || line.slice(74) !== " ".repeat(26))).toBe(true);
  });

  it("resizes the open sidebar by dragging its divider", () => {
    const app = new App(createInitialState());
    const ctrlB = { name: "b", sequence: "\u0002", ctrl: true, meta: false, shift: false };
    const mouse = (x: number, kind: "press" | "drag" | "release") => ({
      name: "mouse", sequence: "", ctrl: false, meta: false, shift: false,
      mouse: { x, y: 8, button: kind === "drag" ? 32 : 0, kind }
    });

    app.handleInput(ctrlB);
    expect(renderApp(app).every((line) => line[73] === "│")).toBe(true);

    app.handleInput(mouse(74, "press"));
    app.handleInput(mouse(64, "drag"));
    app.handleInput(mouse(64, "release"));
    const resized = renderApp(app);

    expect(resized.every((line) => line[63] === "│")).toBe(true);
    expect(resized.some((line) => line[73] === "│")).toBe(false);
  });

  it("selects the strongest dynamic palette match instead of an earlier category", async () => {
    const state = createInitialState();
    state.mode = "extension";
    const app = new App(state);
    (app as unknown as {
      listWorkers: () => Promise<unknown[]>;
      loadSessions: () => Promise<unknown[]>;
      listPaletteExtensions: () => Promise<unknown[]>;
    }).listWorkers = async () => [];
    (app as unknown as { loadSessions: () => Promise<unknown[]> }).loadSessions = async () => [];
    (app as unknown as { listPaletteExtensions: () => Promise<unknown[]> }).listPaletteExtensions = async () => [];

    app.handleInput({ name: "p", sequence: "", ctrl: true, meta: false, shift: false });
    for (const char of "general") app.handleInput({ name: char, sequence: char, ctrl: false, meta: false, shift: false });
    await Promise.resolve();
    await Promise.resolve();
    expect(renderApp(app).join("\n")).toContain("General coding agent mode");

    app.handleInput({ name: "return", sequence: "\r", ctrl: false, meta: false, shift: false });
    expect(state.mode).toBe("general");
  });

  it("repaints asynchronous palette items without preloading sessions", async () => {
    const app = new App(createInitialState());
    let repaintCount = 0;
    let sessionLoadCount = 0;
    app.repaint = () => { repaintCount += 1; };
    (app as unknown as {
      listWorkers: () => Promise<Array<{ name: string; active: boolean; ownerName: string | null }>>;
      loadSessions: () => Promise<unknown[]>;
      listPaletteExtensions: () => Promise<unknown[]>;
    }).listWorkers = async () => [{ name: "Builder", active: false, ownerName: "Crew" }];
    (app as unknown as { loadSessions: () => Promise<unknown[]> }).loadSessions = async () => {
      sessionLoadCount += 1;
      return [];
    };
    (app as unknown as { listPaletteExtensions: () => Promise<unknown[]> }).listPaletteExtensions = async () => [];

    app.handleInput({ name: "p", sequence: "", ctrl: true, meta: false, shift: false });
    for (const char of "builder") app.handleInput({ name: char, sequence: char, ctrl: false, meta: false, shift: false });
    await Promise.resolve();
    await Promise.resolve();

    expect(repaintCount).toBeGreaterThan(0);
    expect(sessionLoadCount).toBe(0);
    expect(renderApp(app).join("\n")).toContain("Builder");
  });

  it("renders slash commands inline below the composer in conversation view", () => {
    const state = createInitialState();
    state.blocks = [{ type: "user", text: "existing conversation" }, { type: "assistant", text: "ready" }];
    const app = new App(state);
    for (const event of [{ name: "/", sequence: "/", ctrl: false, meta: false, shift: false }]) app.handleInput(event);
    const lines = renderApp(app);
    const composer = lines.findIndex((line) => line.includes("General »"));
    const commands = lines.findIndex((line) => line.includes("Commands") && line.includes("esc"));
    expect(commands).toBeGreaterThan(composer);
    expect(lines.slice(Math.max(0, commands - 2), commands + 3).some((line) => line.includes("╭") || line.includes("╮"))).toBe(false);
  });

  it("renders the command palette as a centered modal with esc affordance and footer", () => {
    const app = new App(createInitialState());
    app.handleInput({ name: "p", sequence: "", ctrl: true, meta: false, shift: false });
    const lines = renderApp(app);

    const titleRow = lines.findIndex((line) => line.includes("Commands") && line.includes("esc"));
    expect(titleRow).toBeGreaterThan(0); // modal is centered, not at the top edge

    // Bordered box around the content.
    expect(lines.some((line) => line.includes("╭") && line.includes("╮"))).toBe(true);
    expect(lines.some((line) => line.includes("╰") && line.includes("╯"))).toBe(true);
    // Footer hint with esc-to-close.
    expect(lines.some((line) => line.includes("esc close"))).toBe(true);
  });

  it("paints modal rows with an opaque modal background", () => {
    const app = new App(createInitialState());
    app.handleInput({ name: "p", sequence: "", ctrl: true, meta: false, shift: false });
    const rendered = app.render({ theme: crewCoderTheme, size: SIZE });
    const modalRows = rendered.filter((line) => stripAnsi(line).includes("Commands") || stripAnsi(line).includes("/new"));
    expect(modalRows.length).toBeGreaterThan(0);
    for (const line of modalRows) {
      expect(line).toContain(bg(crewCoderTheme.backgroundAlt));
      expect(line).toContain(`${reset()}${fg(crewCoderTheme.borderStrong)}│`);
    }
  });

  it("closes any command/picker modal on Escape", () => {
    const app = new App(createInitialState());
    app.handleInput({ name: "p", sequence: "", ctrl: true, meta: false, shift: false });
    expect(renderApp(app).some((line) => line.includes("esc close"))).toBe(true);

    app.handleInput({ name: "escape", sequence: "", ctrl: false, meta: false, shift: false });
    expect(renderApp(app).some((line) => line.includes("esc close"))).toBe(false);
  });

  it("uses the full conversation surface while the transcript scrolls", () => {
    const state = createInitialState();
    state.blocks = [{ type: "user", text: "build me a spinner" }];
    for (let i = 0; i < 18; i++) state.blocks.push({ type: "assistant", text: `answer ${i}` });
    const app = new App(state);

    const bottomLines = renderApp(app);
    expect(bottomLines.some((line) => line.includes("build me a spinner"))).toBe(false);
    expect(bottomLines.some((line) => line.includes("Code with a Crew") || line.includes("CrewCoder Agent"))).toBe(false);
    expect(bottomLines.slice(0, 4).some((line) => line.includes("answer"))).toBe(true);

    state.viewportScroll = Number.MAX_SAFE_INTEGER;
    const topLines = renderApp(app);
    expect(topLines.some((line) => line.includes("Code with a Crew") || line.includes("CrewCoder Agent"))).toBe(false);
    expect(topLines.some((line) => line.includes("build me a spinner"))).toBe(true);
  });

  it("renders crew tasks in the right sidebar", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-tui-tasks-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-tui-home-"));
    const crewCoderHome = path.join(home, ".crewcoder");
    process.env.CREWCODER_HOME = crewCoderHome;
    fs.mkdirSync(path.join(crewCoderHome, "tasks"), { recursive: true });
    fs.writeFileSync(path.join(crewCoderHome, "tasks", "config.json"), JSON.stringify({ version: 1, enabled: true }), "utf8");
    fs.mkdirSync(path.join(cwd, ".crewcoder", "tasks"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".crewcoder", "tasks", "tasks.json"), JSON.stringify({
      version: 1,
      nextId: 4,
      tasks: [
        { id: "1", subject: "Set up database schema", status: "pending", sessionId: "session_tasks", projectPath: cwd, metadata: {}, blocks: [], blockedBy: [], createdAt: 1, updatedAt: 1 },
        { id: "2", subject: "Build auth service", status: "in_progress", sessionId: "session_tasks", projectPath: cwd, metadata: {}, blocks: [], blockedBy: [], createdAt: 2, updatedAt: 2 },
        { id: "3", subject: "Write docs", status: "completed", sessionId: "session_tasks", projectPath: cwd, metadata: {}, blocks: [], blockedBy: [], createdAt: 3, updatedAt: 3 }
      ]
    }), "utf8");

    const state = createInitialState();
    state.cwd = cwd;
    state.sessionId = "session_tasks";
    state.blocks.push({ type: "user", text: "continue" });
    const app = new App(state);
    app.handleInput({ name: "b", sequence: "\u0002", ctrl: true, meta: false, shift: false });
    const lines = renderApp(app);

    const rendered = lines.join("\n");
    expect(rendered).toContain("CREW TASKS 1/3");
    expect(rendered).toContain("◉ 2. Build auth service");
    expect(rendered).toContain("○ 1. Set up database");
    expect(rendered).toContain("schema");
    expect(rendered.indexOf("MODIFIED FILES")).toBeLessThan(rendered.indexOf("CREW TASKS"));
  });
});
