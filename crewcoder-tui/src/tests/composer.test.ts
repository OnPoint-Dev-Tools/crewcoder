import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Composer } from "../components/Composer.js";
import { createInitialState } from "../state/tui-store.js";
import { crewCoderTheme } from "../theme/theme.js";
import { bg, fg, reset, stripAnsi } from "../tui/ansi.js";

function pngBuffer(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

describe("Composer", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-composer-"));
    process.env.CREWCODER_HOME = home;
  });

  afterEach(() => {
    delete process.env.CREWCODER_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  });
  it("wraps growing input and renders a visible cursor bar", () => {
    const state = createInitialState();
    state.input = "alpha beta gamma delta";
    const composer = new Composer(state, () => {});

    const lines = composer.render({ theme: crewCoderTheme, size: { width: 16, height: 8 } });
    const plain = lines.map(stripAnsi);

    const bottomBorderIndex = plain.findIndex((line) => /^  ▁+  $/.test(line));
    const renderedInput = plain.slice(1, bottomBorderIndex).join("").replace(/[│>\s]/g, "");
    expect(renderedInput).toContain(state.input.replace(/\s/g, ""));
    expect(lines.join("\n")).toContain(bg(crewCoderTheme.accent));
  });

  it("fills input rows with the active theme's backgroundAlt token", () => {
    const state = createInitialState();
    const composer = new Composer(state, () => {});
    const theme = { ...crewCoderTheme, backgroundAlt: "#123456" };

    const rendered = composer.render({ theme, size: { width: 40, height: 8 } });
    const topBorder = rendered[0]!;
    const inputLine = rendered[1]!;
    const bottomBorder = rendered[2]!;

    expect(topBorder.startsWith(`  ${bg(theme.backgroundAlt)}${fg(theme.border)}`)).toBe(true);
    expect(stripAnsi(topBorder)).toMatch(/^  ▔+  $/);
    expect(inputLine.startsWith(`  ${bg(theme.backgroundAlt)}`)).toBe(true);
    expect(inputLine).toContain(`${fg(theme.borderStrong)}│`);
    expect(stripAnsi(inputLine).startsWith("  │ General >")).toBe(true);
    expect(inputLine).toContain(`${reset()}${bg(theme.backgroundAlt)}`);
    expect(inputLine.endsWith(`${reset()}  `)).toBe(true);
    expect(bottomBorder.startsWith(`  ${bg(theme.backgroundAlt)}${fg(theme.border)}`)).toBe(true);
    expect(stripAnsi(bottomBorder)).toMatch(/^  ▁+  $/);
    expect(stripAnsi(inputLine)).toHaveLength(40);
  });

  it("shows the active worker or mode in the prompt", () => {
    const state = createInitialState();
    const composer = new Composer(state, () => {});

    expect(composer.render({ theme: crewCoderTheme, size: { width: 80, height: 8 } }).map(stripAnsi).join("\n")).toContain("General >");

    state.mode = "plugin";
    expect(composer.render({ theme: crewCoderTheme, size: { width: 80, height: 8 } }).map(stripAnsi).join("\n")).toContain("Plugin >");

    state.mode = "extension";
    expect(composer.render({ theme: crewCoderTheme, size: { width: 80, height: 8 } }).map(stripAnsi).join("\n")).toContain("Extension >");

    state.worker = "scout";
    const workerPrompt = composer.render({ theme: crewCoderTheme, size: { width: 80, height: 8 } }).map(stripAnsi).join("\n");
    expect(workerPrompt).toContain("Scout >");
    expect(workerPrompt).not.toContain("Plugin >");
  });

  it("renders context-window usage without pricing", () => {
    const state = createInitialState();
    state.usage = { turns: 1, contextWindow: 200_000, lastInputTokens: 12_400, totalTokens: 12_400 };
    const composer = new Composer(state, () => {});

    const statusLine = stripAnsi(composer.render({ theme: crewCoderTheme, size: { width: 80, height: 8 } }).at(-1) ?? "");

    expect(statusLine).toContain("◔ 12.4k/200k - 6% | 12.4k tokens");
    expect(statusLine).not.toContain("$");
  });

  it("aligns session access and usage below the spaced composer border", () => {
    const state = createInitialState();
    const composer = new Composer(state, () => {});

    const rendered = composer.render({ theme: crewCoderTheme, size: { width: 80, height: 8 } });
    const lines = rendered.map(stripAnsi);

    expect(lines[0]).toMatch(/^  ▔+  $/);
    expect(lines[0]).toHaveLength(80);
    expect(lines[2]).toMatch(/^  ▁+  $/);
    expect(lines[2]).toHaveLength(80);
    expect(lines.at(-3)?.trim()).toBe("");
    expect(lines.at(-2)).toMatch(/^━+$/);
    expect(lines.at(-1)).toContain("● Review");
    expect(rendered.at(-1)).toContain(`${fg(crewCoderTheme.glow)}●`);
    expect(lines.at(-1)).not.toContain("Ctrl+O expand tools");
    expect(lines.at(-1)).toContain("?/? - ?% | ? tokens");

    state.fullAccess = true;
    const fullAccessLine = stripAnsi(composer.render({ theme: crewCoderTheme, size: { width: 80, height: 8 } }).at(-1) ?? "");
    expect(fullAccessLine).toContain("● Full Access");
    expect(fullAccessLine).not.toContain("● Review");
  });

  it("shows the expand-tools hint only when tool output is collapsed", () => {
    const state = createInitialState();
    state.blocks.push({ type: "tool", name: "bash", status: "done", text: Array.from({ length: 11 }, (_, index) => `line ${index}`).join("\n") });
    const composer = new Composer(state, () => {});

    const collapsed = stripAnsi(composer.render({ theme: crewCoderTheme, size: { width: 180, height: 8 } }).at(-1) ?? "");
    expect(collapsed).toContain("Ctrl+O expand tools  ?/? - ?% | ? tokens");

    state.toolOutputExpanded = true;
    const expanded = stripAnsi(composer.render({ theme: crewCoderTheme, size: { width: 180, height: 8 } }).at(-1) ?? "");
    expect(expanded).toContain("tools expanded  ?/? - ?% | ? tokens");
  });

  it("shows mode and model to the right of access below the composer", () => {
    const state = createInitialState();
    state.worker = "builder";
    state.provider = "anthropic";
    state.model = "claude-sonnet";
    const composer = new Composer(state, () => {});

    const statusLine = stripAnsi(composer.render({ theme: crewCoderTheme, size: { width: 180, height: 8 } }).at(-1) ?? "");

    expect(statusLine).toContain("● Review  ◈ MODE: worker:builder  ◈ MODEL: anthropic/claude-sonnet  ◈ EFFORT:");
  });

  it("keeps the first line's tail visible under the active-context prompt", () => {
    const state = createInitialState();
    // Distinct characters (none of which appear in the prompt), longer than the
    // first-line text budget, must wrap instead of being truncated
    // behind the prompt.
    state.input = "ACEFGHJKMNPQRSTVWXYZ0123456789";
    const composer = new Composer(state, () => {});

    const lines = composer.render({ theme: crewCoderTheme, size: { width: 30, height: 8 } }).map(stripAnsi);
    const bottomRuleIndex = lines.findIndex((line, index) => index > 0 && /^  ▁+  $/.test(line));
    const inputRegion = lines.slice(1, bottomRuleIndex).join("");

    // No character of the wrapped input is dropped or replaced by an ellipsis.
    expect(inputRegion).not.toContain("…");
    for (const ch of state.input) expect(inputRegion).toContain(ch);
  });

  it("inserts a newline on shift enter and submits on enter", () => {
    const state = createInitialState();
    const submitted: string[] = [];
    const composer = new Composer(state, (value) => submitted.push(value));

    for (const sequence of "first") {
      composer.handleInput?.({ name: sequence, sequence, ctrl: false, meta: false, shift: false });
    }
    composer.handleInput?.({ name: "return", sequence: "\r", ctrl: false, meta: false, shift: true });
    for (const sequence of "second") {
      composer.handleInput?.({ name: sequence, sequence, ctrl: false, meta: false, shift: false });
    }
    composer.handleInput?.({ name: "return", sequence: "\r", ctrl: false, meta: false, shift: false });

    expect(submitted).toEqual(["first\nsecond"]);
    expect(state.input).toBe("");
  });

  it("edits at the cursor instead of only appending", () => {
    const state = createInitialState();
    state.input = "helo";
    state.inputCursor = state.input.length;
    const composer = new Composer(state, () => {});

    composer.handleInput?.({ name: "left", sequence: "\u001b[D", ctrl: false, meta: false, shift: false });
    composer.handleInput?.({ name: "l", sequence: "l", ctrl: false, meta: false, shift: false });
    composer.handleInput?.({ name: "delete", sequence: "\u001b[3~", ctrl: false, meta: false, shift: false });

    expect(state.input).toBe("hell");
    expect(state.inputCursor).toBe(4);
  });

  it("ignores escape instead of inserting it", () => {
    const state = createInitialState();
    state.input = "hello";
    state.inputCursor = state.input.length;
    const composer = new Composer(state, () => {});

    const handled = composer.handleInput?.({ name: "escape", sequence: "\u001b", ctrl: false, meta: false, shift: false });

    expect(handled).toBe(true);
    expect(state.input).toBe("hello");
    expect(state.inputCursor).toBe(5);
  });

  it("copies selected composer text on mouse release", () => {
    const state = createInitialState();
    state.worker = "scout";
    state.input = "copy me";
    state.inputCursor = state.input.length;
    const composer = new Composer(state, () => {});
    const copied: string[] = [];

    composer.render({ theme: crewCoderTheme, size: { width: 40, height: 8 } });
    // "copy me" renders after the 12-column inset, rail, and "Scout > " prompt,
    // so the text starts at screen column 13; selecting "copy" spans 13..17.
    composer.handleMouse({ name: "mouse", sequence: "", ctrl: false, meta: false, shift: false, mouse: { x: 13, y: 2, button: 0, kind: "press" } }, 1, (text) => { copied.push(text); return true; });
    composer.handleMouse({ name: "mouse", sequence: "", ctrl: false, meta: false, shift: false, mouse: { x: 17, y: 2, button: 32, kind: "drag" } }, 1, (text) => { copied.push(text); return true; });
    composer.handleMouse({ name: "mouse", sequence: "", ctrl: false, meta: false, shift: false, mouse: { x: 17, y: 2, button: 0, kind: "release" } }, 1, (text) => { copied.push(text); return true; });

    const rerendered = composer.render({ theme: crewCoderTheme, size: { width: 40, height: 8 } });

    expect(copied).toEqual(["copy"]);
    expect(rerendered.join("\n")).not.toContain(bg("#2f6f5a"));
  });

  it("attaches local image paths found in submitted text", () => {
    const imagePath = path.join(home, "Screenshot_2026-06-30.png");
    fs.writeFileSync(imagePath, pngBuffer(320, 200));
    const state = createInitialState();
    state.input = `testing image rendering ${imagePath}`;
    state.inputCursor = state.input.length;
    const submitted: string[] = [];
    const composer = new Composer(state, (value) => submitted.push(value));

    composer.handleInput?.({ name: "return", sequence: "\r", ctrl: false, meta: false, shift: false });

    expect(submitted).toEqual([`testing image rendering ${imagePath}`]);
    expect(state.attachments).toHaveLength(1);
    expect(state.attachments[0]).toMatchObject({ source: "file", mime: "image/png", width: 320, height: 200 });
    expect(fs.existsSync(state.attachments[0]!.path)).toBe(true);
  });
});
