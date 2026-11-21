import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RGBA } from "@opentui/core";
import { setRendererCapabilities } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, riskLevel } from "../App.js";
import { MENTION_EMPTY_TEXT } from "../components/MentionList.js";
import { AGENT_WORK_TITLE, IMAGE_FAILED_TEXT } from "../components/Transcript.js";
import type { PathLister, PathSuggestion } from "../path-suggestions.js";
import type { ClipboardSource } from "../attachments.js";
import { fakeClipboard, isolateImageCache, pngBytes, pngFile, solidPng, solidPngFile } from "./fake-images.js";
import { IMAGE_PROTOCOL_ENV } from "../image-view.js";
import { MotionContext } from "../hooks/use-motion.js";
import { SEARCH_MARKER } from "../glyphs.js";
import { logoPulseColor, PULSE_FRAME_MS, PULSE_FREEZE_MS, PULSE_PERIOD_MS } from "../logo-pulse.js";
import { AppThemeProvider } from "../providers/app-theme-provider.js";
import { ThemeProvider } from "../providers/theme-provider.js";
import { SessionController } from "../session-controller.js";
import { registerBundledGrammars } from "../syntax/grammars.js";
import { slateAppTheme, slateTheme, toAppTheme, type AppTheme } from "../theme.js";
import { crewCoderTheme, lightCrewCoderTheme, slateCrewCoderTheme } from "@onpoint-dev-tools/crewcoder-tui-core/theme/crewcoder-theme";
import { Root } from "../Root.js";
import { EXAMPLE_THEMES_DIR } from "../theme-controller.js";
import { COLLAPSED_OUTPUT_LINES } from "../tool-presentation.js";
import { FakeBridge } from "./fake-bridge.js";
import { FakeCli, flush } from "./fake-cli.js";
import { DISABLED_TASKS } from "@onpoint-dev-tools/crewcoder-tui-core/state/crew-tasks";
import type { TaskReader } from "../sidebar.js";

type Setup = Awaited<ReturnType<typeof testRender>>;
let active: Setup | undefined;

afterEach(async () => {
  await active?.dispose();
  active = undefined;
});

type RenderOptions = { kittyKeyboard?: boolean; width?: number; height?: number; exitOnCtrlC?: boolean; readTasks?: TaskReader; theme?: AppTheme };

async function renderApp(cli = new FakeCli(), options: RenderOptions = {}): Promise<{ setup: Setup; bridge: FakeBridge; controller: SessionController; onQuit: ReturnType<typeof vi.fn> }> {
  const bridge = new FakeBridge();
  // Never the real task store: the sidebar would read ~/.crewcoder and the cwd.
  const { readTasks = async () => DISABLED_TASKS, theme = slateAppTheme, ...renderOptions } = options;
  const controller = new SessionController(bridge, undefined, cli, undefined, undefined, undefined, readTasks);
  const onQuit = vi.fn();
  const setup = await testRender(
    <AppThemeProvider theme={theme}>
      <App controller={controller} onQuit={onQuit} />
    </AppThemeProvider>,
    { width: 80, height: 24, ...renderOptions }
  );
  active = setup;
  await setup.renderOnce();
  return { setup, bridge, controller, onQuit };
}

/** Send a prompt and wait until the conversation (not the welcome screen) shows. */
async function inConversation(options: { kittyKeyboard?: boolean; width?: number; height?: number; theme?: AppTheme } = {}, prompt = "hi") {
  const rendered = await renderApp(new FakeCli(), options);
  await rendered.setup.mockInput.typeText(prompt);
  rendered.setup.mockInput.pressEnter();
  return rendered;
}

const PAGE_UP = "\x1b[5~";
const CTRL_END = "\x1b[1;5F";
const toolResult = (text: string) => ({ content: [{ type: "text", text }] });
const lines = (count: number, prefix = "line"): string => Array.from({ length: count }, (_, index) => `${prefix} ${index}`).join("\n");

describe("full-screen transcript", () => {
  it("shows the prompt, the Reasoning panel, and the reply, with the spinner only while running", async () => {
    const { setup, bridge } = await inConversation({}, "hello crew");
    expect(bridge.runs).toEqual([expect.objectContaining({ prompt: "hello crew" })]);

    bridge.emit({ type: "agent_start", sessionId: "s-9" });
    bridge.emit({ type: "thinking_delta", text: "considering" });
    bridge.emit({ type: "assistant_delta", text: "hi there" });
    const live = await setup.waitForFrame((text) => text.includes("Working") && text.includes("hi there"));
    // The user's message: a filled circle on the same row, left of the text (no YOU label above).
    expect(live).not.toContain("YOU");
    expect(live.split("\n").find((line) => line.includes("hello crew"))?.trim()).toBe("● hello crew");
    const marker = setup.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.includes("●"));
    expect(marker?.fg.equals(RGBA.fromHex(slateTheme.colors.primary))).toBe(true);
    expect(live).toContain("💭 Reasoning");
    expect(live).toContain("considering");
    expect(live).toContain("CREW CODER");
    // The status line names the session by its first prompt, never by its raw id.
    const statusRow = live.split("\n")[23] ?? "";
    expect(statusRow).toContain("hello crew");
    expect(live).not.toContain("s-9");

    bridge.emit({ type: "agent_end" });
    const idle = await setup.waitForFrame((text) => !text.includes("Working"));
    expect(idle).toContain("hi there");
    expect(idle).toContain("hello crew");
  });

  it("shows the reply's generation speed beside CREW CODER once message_end reports it", async () => {
    const { setup, bridge } = await inConversation({}, "speed");
    bridge.emit({ type: "assistant_delta", text: "fast reply" });
    const streaming = await setup.waitForFrame((text) => text.includes("fast reply"));
    expect(streaming).not.toContain("tok/s");

    bridge.emit({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "fast reply" }] },
      durationMs: 2_000,
      outputTokens: 85
    });
    const done = await setup.waitForFrame((text) => text.includes("tok/s"));
    const lines = done.split("\n");
    expect(lines.find((line) => line.includes("CREW CODER"))).toContain("CREW CODER 42.5 tok/s");
    const rate = setup.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.includes("tok/s"));
    expect(rate?.fg.equals(RGBA.fromHex(slateTheme.colors.mutedForeground))).toBe(true);
  });

  it("switches to single-cell icons when the terminal turns out to be behind tmux", async () => {
    const { setup, bridge } = await inConversation({}, "icons");
    bridge.emit({ type: "thinking_delta", text: "pondering" });
    bridge.emit({ type: "tool_execution_start", toolName: "bash", toolCallId: "g1", args: { command: "ls" } });
    await setup.waitForFrame((text) => text.includes("💭 Reasoning") && text.includes("💻 Run Command"));

    // setRendererCapabilities only stores them; the real renderer also emits the probe's answer.
    act(() => {
      setup.renderer.emit("capabilities", setRendererCapabilities(setup.renderer, { unicode: "unicode", multiplexer: "tmux" }));
    });
    const text = await setup.waitForFrame((frame) => frame.includes("∴ Reasoning") && frame.includes("$ Run Command"));
    expect(text).not.toContain("💭");
    expect(text).not.toContain("💻");

    act(() => {
      setup.renderer.emit("capabilities", setRendererCapabilities(setup.renderer, { unicode: "unicode-wide", multiplexer: "none" }));
    });
    await setup.waitForFrame((frame) => frame.includes("💭 Reasoning") && frame.includes("💻 Run Command"));
  });

  it("shows access, model, and live context usage with cost in the status line", async () => {
    const { setup, bridge, controller } = await inConversation();
    const statusRow = (frame: string): string => frame.split("\n")[23] ?? "";
    const before = await setup.waitForFrame((text) => statusRow(text).includes("Review"));
    expect(statusRow(before)).not.toContain("tokens");

    bridge.emit({ type: "usage_update", summary: { turns: 1, contextWindow: 200_000, lastInputTokens: 12_400, totalTokens: 15_000, costUsd: 0.034 } });
    const live = await setup.waitForFrame((text) => statusRow(text).includes("$0.03"));
    expect(statusRow(live)).toContain("Review · general · claude/");
    expect(statusRow(live).trimEnd().endsWith("◔ 12.4k/200k - 6% | 15k tokens | $0.03")).toBe(true);

    controller.state.fullAccess = true;
    bridge.emit({ type: "agent_end" });
    await setup.waitForFrame((text) => statusRow(text).includes("Full Access"));
  });

  it("keeps the composer and status line at the bottom", async () => {
    const { setup, bridge } = await inConversation();
    bridge.emit({ type: "agent_end" });
    const frame = await setup.waitForFrame((text) => text.includes("Ask CrewCoder") && !text.includes("Type your first request") && !text.includes("Working"));
    const rows = frame.split("\n").slice(0, 24);
    expect(rows[23]).toContain("claude");
    expect(rows[21]).toContain("Ask CrewCoder");
  });

  it("scrolls with PageUp and returns to the newest output with Ctrl+End", async () => {
    const { setup, bridge } = await inConversation();
    bridge.emit({ type: "assistant_delta", text: lines(60, "row") });
    bridge.emit({ type: "agent_end" });
    await setup.waitForFrame((text) => text.includes("row 59"));

    // The mock has no PageUp/Ctrl+End codes; send the xterm sequences.
    setup.mockInput.pressKey(PAGE_UP);
    setup.mockInput.pressKey(PAGE_UP);
    const scrolled = await setup.waitForFrame((text) => !text.includes("row 59"));
    expect(scrolled).toContain("row ");

    setup.mockInput.pressKey(CTRL_END);
    await setup.waitForFrame((text) => text.includes("row 59"));
  });
});

describe("Agent work", () => {
  it("shows a running tool live in the dashed Agent work box, not in the footer", async () => {
    const { setup, bridge } = await inConversation({}, "test");
    bridge.emit({ type: "tool_execution_start", toolName: "bash", toolCallId: "t1", args: { command: "npm test" } });

    const running = await setup.waitForFrame((text) => text.includes("Run Command") && text.includes("running…"));
    expect(running).toContain(AGENT_WORK_TITLE);
    expect(running).toContain("╌");
    expect(running).toContain("╎");
    expect(running).toContain("npm test");
    // The footer holds only the spinner, composer, and status: the tool shows once.
    expect(running.split("Run Command")).toHaveLength(2);

    bridge.emit({ type: "tool_execution_end", toolName: "bash", toolCallId: "t1", result: toolResult("all green") });
    const done = await setup.waitForFrame((text) => text.includes("all green"));
    expect(done).toContain("✓");
    expect(done).not.toContain("running…");
  });

  it("stacks consecutive tools in one box and shows read contents", async () => {
    const { setup, bridge } = await inConversation();
    bridge.emit({ type: "tool_execution_start", toolName: "read", toolCallId: "r1", args: { path: "src/a.ts" } });
    bridge.emit({ type: "tool_execution_end", toolName: "read", toolCallId: "r1", result: toolResult("export const a = 1;") });
    bridge.emit({ type: "tool_execution_start", toolName: "grep", toolCallId: "g1", args: { pattern: "TODO" } });
    bridge.emit({ type: "tool_execution_end", toolName: "grep", toolCallId: "g1", result: toolResult("src/a.ts:3: TODO") });
    bridge.emit({ type: "agent_end" });

    const frame = await setup.waitForFrame((text) => text.includes("src/a.ts:3: TODO"));
    expect(frame).toContain("Read File");
    expect(frame).toContain("export const a = 1;");
    expect(frame).toContain("Search");
    expect(frame.split(AGENT_WORK_TITLE)).toHaveLength(2);
  });

  it("collapses long output to its first lines, and expands it with Ctrl+O or a click", async () => {
    const { setup, bridge } = await inConversation({ height: 60 });
    const hidden = 30 - COLLAPSED_OUTPUT_LINES;
    bridge.emit({ type: "tool_execution_start", toolName: "read", toolCallId: "r1", args: { path: "big.ts" } });
    bridge.emit({ type: "tool_execution_end", toolName: "read", toolCallId: "r1", result: toolResult(lines(30, "src")) });
    bridge.emit({ type: "agent_end" });

    const collapsed = await setup.waitForFrame((text) => text.includes(`Show ${hidden} more lines`));
    expect(collapsed).toContain(`src ${COLLAPSED_OUTPUT_LINES - 1}`);
    expect(collapsed).not.toContain(`src ${COLLAPSED_OUTPUT_LINES}\n`);
    expect(collapsed).not.toContain("src 29");

    setup.mockInput.pressKey("o", { ctrl: true });
    const expanded = await setup.waitForFrame((text) => text.includes("src 29"));
    expect(expanded).toContain("Show less");

    setup.mockInput.pressKey("o", { ctrl: true });
    const again = await setup.waitForFrame((text) => !text.includes("src 29"));
    const rows = again.split("\n");
    const toggleRow = rows.findIndex((row) => row.includes("Show 18 more lines"));
    await setup.mockMouse.click(rows[toggleRow]!.indexOf("Show"), toggleRow);
    await setup.waitForFrame((text) => text.includes("src 29") && text.includes("Show less"));
  });
});

describe("structured panels", () => {
  it("shows a background job live in its own panel and settles it with the exit code", async () => {
    const { setup, bridge } = await inConversation({ height: 40 }, "serve");
    bridge.emit({ type: "background_job_start", bgId: "bg-7", command: "npm run dev", startedAt: "2026-11-19T00:00:00Z" });
    const waiting = await setup.waitForFrame((text) => text.includes("Background job · running"));
    expect(waiting).toContain("npm run dev");
    expect(waiting).toContain("(waiting for output)");
    expect(waiting).toContain("╭");
    expect(waiting).not.toContain("not rendered");

    bridge.emit({ type: "background_job_output", bgId: "bg-7", text: "\x1b[32mready on :3000\x1b[0m\n" });
    await setup.waitForFrame((text) => text.includes("ready on :3000") && !text.includes("waiting for output"));
    bridge.emit({ type: "background_job_end", bgId: "bg-7", status: "completed", exitCode: 0 });
    const done = await setup.waitForFrame((text) => text.includes("Background job · completed"));
    expect(done).toContain("bg-7 · exit 0");
  });

  it("shows plugin validation errors and a crew roster as they arrive", async () => {
    const { setup, bridge } = await inConversation({ height: 40 }, "validate");
    bridge.emit({ type: "validation_start", target: "plugins/board" });
    await setup.waitForFrame((text) => text.includes("Validation · running") && text.includes("plugins/board"));
    bridge.emit({ type: "validation_end", target: "plugins/board", ok: false, errors: ["manifest is missing id"] });
    await setup.waitForFrame((text) => text.includes("Validation · failed") && text.includes("✗ manifest is missing id"));

    bridge.emit({ type: "crew_start", workers: ["planner", "builder"] });
    bridge.emit({ type: "crew_worker_start", worker: "planner", index: 0, total: 2 });
    const running = await setup.waitForFrame((text) => text.includes("Crew running") && text.includes("1 active"));
    expect(running).toContain("○ builder");
    bridge.emit({ type: "crew_worker_end", worker: "planner", status: "completed" });
    bridge.emit({ type: "crew_worker_end", worker: "builder", status: "failed", error: "tests failed" });
    bridge.emit({ type: "crew_end" });
    const done = await setup.waitForFrame((text) => text.includes("Crew finished with failures"));
    expect(done).toContain("✓ planner");
    expect(done).toContain("✗ builder");
    expect(done).toContain("tests failed");
  });
});

describe("crews", () => {
  it("/team streams workers into the transcript and fills the sidebar's AGENTS roster", async () => {
    const { setup, bridge, controller } = await renderApp(new FakeCli(), { width: 110, height: 50 });
    // Commands run on a microtask; let it start the crew.
    await act(async () => {
      controller.submit("/team feature ship the parser");
      await flush();
    });
    expect(bridge.crews[0]).toMatchObject({ target: { kind: "team", team: "feature" }, prompt: "ship the parser" });

    bridge.emit({ type: "crew_start", workers: ["planner", "builder"] });
    bridge.emit({ type: "crew_worker_start", worker: "planner", index: 0, total: 2 });
    bridge.emit({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "Plan: ship the parser" }] } });
    bridge.emit({ type: "tool_execution_start", toolName: "read", toolCallId: "r1", args: { path: "src/parser.ts" } });
    bridge.emit({ type: "tool_execution_end", toolName: "read", toolCallId: "r1", result: toolResult("export {}") });
    bridge.emit({ type: "assistant_delta", text: "Plan ready." });
    bridge.emit({ type: "agent_end" });
    const live = await setup.waitForFrame((text) => text.includes("Plan ready.") && text.includes("AGENTS: planner"));
    expect(live).toContain("/team feature ship the parser");
    expect(live).toContain("TASK → planner");
    expect(live).toContain(`${AGENT_WORK_TITLE} · planner`);
    expect(live).toContain("CREW CODER · planner");
    expect(live).toContain("Crew running");
    // Between workers the run is still live.
    expect(live).toContain("Working");

    bridge.emit({ type: "crew_worker_end", worker: "planner", index: 0, total: 2, status: "completed" });
    bridge.emit({ type: "crew_worker_start", worker: "builder", index: 1, total: 2 });
    bridge.emit({ type: "assistant_delta", text: "Built it." });
    const second = await setup.waitForFrame((text) => text.includes("CREW CODER · builder") && text.includes("AGENTS: builder"));
    expect(second).toContain("Built it.");

    bridge.emit({ type: "crew_worker_end", worker: "builder", index: 1, total: 2, status: "completed" });
    bridge.emit({ type: "crew_end", total: 2, completed: 2, failed: 0 });
    const done = await setup.waitForFrame((text) => text.includes("Crew complete") && !text.includes("Working"));
    // A finished crew leaves the sidebar; its roster stays in the transcript panel.
    expect(done).not.toContain("AGENTS:");
  });
});

describe("syntax highlighting", () => {
  /** Waits until `word` is drawn in `hex`; Tree-sitter answers from a worker, after the first frame. */
  async function waitForColor(setup: Setup, word: string, hex: string): Promise<void> {
    const color = RGBA.fromHex(hex);
    const deadline = Date.now() + 8_000;
    for (;;) {
      await setup.renderOnce();
      const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
      if (spans.some((span) => span.text.includes(word) && span.fg.equals(color))) return;
      if (Date.now() > deadline) throw new Error(`"${word}" never drew in ${hex}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  it("highlights a fenced block in a bundled language behind its rail", async () => {
    registerBundledGrammars();
    const { setup, bridge } = await inConversation({ height: 30 });
    bridge.emit({ type: "assistant_delta", text: "Try:\n\n```python\ndef greet():\n    return 'hi'\n```\n" });
    bridge.emit({ type: "agent_end" });
    const frame = await setup.waitForFrame((text) => text.includes("def greet():"));
    expect(frame).toMatch(/│ def greet\(\):/);
    await waitForColor(setup, "def", slateAppTheme.syntax.keyword);
  });

  it("colors code with the active theme's syntax palette", async () => {
    registerBundledGrammars();
    const theme = toAppTheme({ ...crewCoderTheme, name: "custom", syntax: { ...crewCoderTheme.syntax, keyword: "#ff00aa", string: "#00ffaa" } });
    const { setup, bridge } = await inConversation({ height: 30, theme });
    bridge.emit({ type: "assistant_delta", text: "```python\ndef greet():\n    return 'hi'\n```\n" });
    bridge.emit({ type: "agent_end" });
    await setup.waitForFrame((text) => text.includes("def greet():"));
    await waitForColor(setup, "def", "#ff00aa");
    await waitForColor(setup, "'hi'", "#00ffaa");
  });

  const markdownTheme = toAppTheme({
    ...crewCoderTheme,
    name: "md",
    markdown: { ...crewCoderTheme.markdown, heading: "#ff0001", strong: "#ff0002", code: "#ff0003", link: "#ff0004", listMarker: "#ff0005" }
  });

  it("draws a reply's markdown elements in the theme's markdown colors", async () => {
    const { setup, bridge } = await inConversation({ height: 30, theme: markdownTheme });
    bridge.emit({ type: "assistant_delta", text: "# Plan\n\n- run **tests** with `npm test`\n- see [docs](https://example.com)\n" });
    bridge.emit({ type: "agent_end" });
    await setup.waitForFrame((text) => text.includes("Plan") && text.includes("npm test"));
    await waitForColor(setup, "Plan", "#ff0001");
    // A rendered reply hides the markdown syntax.
    const frame = setup.captureCharFrame();
    expect(frame).not.toContain("# Plan");
    expect(frame).not.toContain("**tests**");
    await waitForColor(setup, "tests", "#ff0002");
    await waitForColor(setup, "npm test", "#ff0003");
    await waitForColor(setup, "docs", "#ff0004");
    await waitForColor(setup, "-", "#ff0005");
  });

  it("highlights a read markdown file's elements like a rendered reply", async () => {
    const { setup, bridge } = await inConversation({ height: 30, theme: markdownTheme });
    bridge.emit({ type: "tool_execution_start", toolName: "read", toolCallId: "r1", args: { path: "README.md" } });
    bridge.emit({ type: "tool_execution_end", toolName: "read", toolCallId: "r1", result: toolResult("# Setup\n\nRun **fast** with `npm ci`.\n") });
    bridge.emit({ type: "agent_end" });
    await setup.waitForFrame((text) => text.includes("Setup") && text.includes("npm ci"));
    await waitForColor(setup, "Setup", "#ff0001");
    await waitForColor(setup, "fast", "#ff0002");
    await waitForColor(setup, "npm ci", "#ff0003");
    // Read output is the file as written. Checked after highlighting: OpenTUI
    // conceals markers only once Tree-sitter has answered.
    const frame = setup.captureCharFrame();
    expect(frame).toContain("# Setup");
    expect(frame).toContain("**fast**");
    expect(frame).toContain("`npm ci`");
  });

  it("keeps a markdown fence in a reply as source, highlighted", async () => {
    const { setup, bridge } = await inConversation({ height: 30, theme: markdownTheme });
    bridge.emit({ type: "assistant_delta", text: "Add this:\n\n```markdown\n## Usage\n\nRun **now**.\n```\n" });
    bridge.emit({ type: "agent_end" });
    await setup.waitForFrame((text) => text.includes("Usage") && text.includes("now"));
    await waitForColor(setup, "Usage", "#ff0001");
    await waitForColor(setup, "now", "#ff0002");
    // After highlighting (concealing would only happen then).
    const frame = setup.captureCharFrame();
    expect(frame).toMatch(/│ ## Usage/);
    expect(frame).toContain("**now**");
  });

  it("highlights read output by the read path and edit diffs by the edited path", async () => {
    registerBundledGrammars();
    // A file reader anchors the edit, so it renders as OpenTUI's <diff> (unanchored edits are tinted lines).
    const bridge = new FakeBridge();
    const controller = new SessionController(bridge, undefined, new FakeCli(), async () => "import os\nx = 'two'\n");
    const setup = await testRender(
      <ThemeProvider theme={slateTheme}><App controller={controller} onQuit={() => {}} /></ThemeProvider>,
      { width: 80, height: 40 }
    );
    active = setup;
    await setup.mockInput.typeText("go");
    setup.mockInput.pressEnter();
    bridge.emit({ type: "tool_execution_start", toolName: "read", toolCallId: "r1", args: { path: "main.go" } });
    bridge.emit({ type: "tool_execution_end", toolName: "read", toolCallId: "r1", result: toolResult("package main\n\nfunc main() {}") });
    bridge.emit({ type: "tool_execution_start", toolName: "edit", toolCallId: "e1", args: { path: "app.py", find: "x = 1", replace: "x = 'two'" } });
    bridge.emit({ type: "tool_execution_end", toolName: "edit", toolCallId: "e1", result: toolResult("Edited app.py") });
    bridge.emit({ type: "agent_end" });
    await setup.waitForFrame((text) => text.includes("func main()") && text.includes("x = 'two'"));
    await waitForColor(setup, "func", slateAppTheme.syntax.keyword);
    await waitForColor(setup, "'two'", slateAppTheme.syntax.string);
  });

  it("leaves a language without a parser as plain text", async () => {
    const { setup, bridge } = await inConversation({ height: 30 });
    bridge.emit({ type: "assistant_delta", text: "```ruby\nputs 'hi'\n```\n" });
    bridge.emit({ type: "agent_end" });
    const frame = await setup.waitForFrame((text) => text.includes("puts 'hi'"));
    expect(frame).toMatch(/│ puts 'hi'/);
  });
});

describe("inline diffs", () => {
  async function edited() {
    const rendered = await inConversation({ height: 40 });
    rendered.bridge.emit({ type: "tool_execution_start", toolName: "edit", toolCallId: "e1", args: { path: "src/app.ts", find: "const value0 = 0;", replace: "const value0 = 42;" } });
    rendered.bridge.emit({ type: "tool_execution_end", toolName: "edit", toolCallId: "e1", result: toolResult("Edited src/app.ts") });
    rendered.bridge.emit({ type: "agent_end" });
    return rendered;
  }

  it("shows an edit's diff in the Agent work box instead of its output", async () => {
    const { setup } = await edited();
    const frame = await setup.waitForFrame((text) => text.includes("const value0 = 42;"));
    expect(frame).toContain("▾ Diff  +1 -1  src/app.ts");
    expect(frame).toContain("const value0 = 0;");
    expect(frame).not.toContain("Edited src/app.ts");
  });

  it("hides and shows diffs with a click on the header and with Ctrl+T", async () => {
    const { setup } = await edited();
    const frame = await setup.waitForFrame((text) => text.includes("▾ Diff"));
    const rows = frame.split("\n");
    const header = rows.findIndex((row) => row.includes("▾ Diff"));
    await setup.mockMouse.click(rows[header]!.indexOf("▾ Diff"), header);
    const hidden = await setup.waitForFrame((text) => text.includes("▸ Diff"));
    expect(hidden).not.toContain("const value0 = 42;");

    // Ctrl+T hides every diff (this one stays hidden), then shows every diff.
    setup.mockInput.pressKey("t", { ctrl: true });
    await setup.renderOnce();
    expect(await setup.waitForFrame((text) => text.includes("▸ Diff"))).not.toContain("const value0 = 42;");
    setup.mockInput.pressKey("t", { ctrl: true });
    await setup.waitForFrame((text) => text.includes("▾ Diff") && text.includes("const value0 = 42;"));
  });

  it("numbers a finished edit with the file's real lines", async () => {
    const bridge = new FakeBridge();
    const file = "line 1\nline 2\nconst value0 = 42;\nline 4\n";
    const controller = new SessionController(bridge, undefined, new FakeCli(), async () => file);
    const setup = await testRender(
      <ThemeProvider theme={slateTheme}><App controller={controller} onQuit={() => {}} /></ThemeProvider>,
      { width: 80, height: 30 }
    );
    active = setup;
    await setup.mockInput.typeText("go");
    setup.mockInput.pressEnter();
    bridge.emit({ type: "tool_execution_start", toolName: "edit", toolCallId: "e1", args: { path: "src/app.ts", find: "const value0 = 0;", replace: "const value0 = 42;" } });
    bridge.emit({ type: "tool_execution_end", toolName: "edit", toolCallId: "e1", result: toolResult("Edited src/app.ts") });
    bridge.emit({ type: "agent_end" });

    const frame = await setup.waitForFrame((text) => /3 \+ const value0 = 42;/.test(text));
    expect(frame).toMatch(/3 - const value0 = 0;/);
  });

  it("shows a created file's diff from the agent's file_diff, with real line numbers", async () => {
    const { setup, bridge } = await inConversation({ height: 40 });
    bridge.emit({ type: "tool_execution_start", toolName: "Codex file change", toolCallId: "c1", args: { changes: [{ path: "test", kind: { type: "add" }, diff: "Hi from crewcoder\n" }] } });
    bridge.emit({ type: "file_diff", toolName: "Codex file change", toolCallId: "c1", files: [{ path: "test", status: "added", additions: 1, deletions: 0, binary: false, truncated: false, patch: "diff --git a/test b/test\nnew file mode 100644\n--- /dev/null\n+++ b/test\n@@ -0,0 +1 @@\n+Hi from crewcoder\n" }] });
    bridge.emit({ type: "tool_execution_end", toolName: "Codex file change", toolCallId: "c1", result: toolResult("[]") });
    bridge.emit({ type: "agent_end" });

    const frame = await setup.waitForFrame((text) => text.includes("▾ Diff  +1 -0  test (new)"));
    expect(frame).toMatch(/1 \+ Hi from crewcoder/);
  });

  it("shows a shell command's output and no diff", async () => {
    const { setup, bridge } = await inConversation({ height: 40 });
    bridge.emit({ type: "tool_execution_start", toolName: "Codex command", toolCallId: "c2", args: { command: "printf 'Hi' > test && cat test" } });
    bridge.emit({ type: "tool_execution_end", toolName: "Codex command", toolCallId: "c2", result: toolResult("Hi from crewcoder") });
    bridge.emit({ type: "agent_end" });

    const frame = await setup.waitForFrame((text) => text.includes("Hi from crewcoder") && text.includes("Run Command"));
    expect(frame).not.toContain("Diff");
  });

  it("collapses a long diff and expands it with Ctrl+O", async () => {
    const { setup, bridge } = await inConversation({ height: 60 });
    bridge.emit({ type: "tool_execution_start", toolName: "write", toolCallId: "w1", args: { path: "big.ts", content: lines(30, "added") } });
    bridge.emit({ type: "tool_execution_end", toolName: "write", toolCallId: "w1", result: toolResult("Wrote big.ts") });
    bridge.emit({ type: "agent_end" });

    const collapsed = await setup.waitForFrame((text) => text.includes(`Show ${30 - COLLAPSED_OUTPUT_LINES} more lines`));
    expect(collapsed).toContain("added 0");
    expect(collapsed).not.toContain("added 29");
    setup.mockInput.pressKey("o", { ctrl: true });
    await setup.waitForFrame((text) => text.includes("added 29") && text.includes("Show less"));
  });
});

describe("approvals", () => {
  it("shows a pending approval card and resolves it only with the configured chord", async () => {
    const { setup, bridge } = await inConversation({}, "clean");
    bridge.emit({ type: "approval_required", approvalId: "a-1", toolName: "bash", risk: "dangerous", reason: "rm -r build", args: { command: "rm -r build" } });

    const frame = await setup.waitForFrame((text) => text.includes("Tool Approval Required"));
    expect(frame).toContain("[HIGH RISK]");
    expect(frame).toContain("waiting for approval");
    expect(frame).toContain("Approve");
    expect(frame).toContain("Deny");

    // Upstream termcn approved on a bare "y"; typing it in the composer must not approve.
    await setup.mockInput.typeText("yes y");
    await setup.renderOnce();
    expect(bridge.approvals).toEqual([]);

    setup.mockInput.pressKey("y", { ctrl: true });
    await setup.renderOnce();
    expect(bridge.approvals).toEqual([{ id: "a-1", approved: true }]);
  });
});

describe("transcript search", () => {
  const openSearch = (setup: Setup): void => setup.mockInput.pressKey("f", { ctrl: true });

  /** Esc, then the next frame that satisfies `ready`; a lone ESC arrives after the parser's escape timeout. */
  async function closeSearch(setup: Setup, ready: (frame: string) => boolean): Promise<string> {
    setup.mockInput.pressEscape();
    let frame = "";
    await vi.waitFor(async () => {
      await setup.renderOnce();
      frame = setup.captureCharFrame();
      expect(ready(frame)).toBe(true);
    }, { timeout: 2_000 });
    return frame;
  }

  it("opens in the composer's place, jumps to the match scrolled out of view, and marks its line", async () => {
    const { setup, bridge } = await inConversation({ height: 24 });
    bridge.emit({ type: "assistant_delta", text: "the needle is here" });
    bridge.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "the needle is here" }] } });
    bridge.emit({ type: "tool_execution_start", toolName: "bash", toolCallId: "b1", args: { command: "ls" } });
    bridge.emit({ type: "tool_execution_end", toolName: "bash", toolCallId: "b1", result: toolResult(lines(40, "row")) });
    bridge.emit({ type: "assistant_delta", text: "last reply" });
    const bottom = await setup.waitForFrame((text) => text.includes("last reply"));
    expect(bottom).not.toContain("the needle is here");

    openSearch(setup);
    await setup.waitForFrame((text) => text.includes("Search the transcript"));
    await setup.mockInput.typeText("needle");
    const markedRow = (text: string): string | undefined => text.split("\n").find((row) => row.startsWith(SEARCH_MARKER));
    // The marker sits in the left margin, on the match's line.
    const found = await setup.waitForFrame((text) => text.includes("1/1") && Boolean(markedRow(text)?.includes("the needle is here")));
    // The composer is replaced; the status line stays.
    expect(found).not.toContain("Send a follow-up");
    expect(found).toContain("Find");
    // The match line in the bar picks the match out.
    const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
    expect(spans.some((span) => span.text === "needle" && span.bg.equals(RGBA.fromHex(slateTheme.colors.warning)))).toBe(true);

    // Esc closes the bar, keeps the run going, and leaves the transcript where it is.
    const closed = await closeSearch(setup, (text) => text.includes("Send a follow-up"));
    expect(bridge.stops).toBe(0);
    expect(closed).toContain("the needle is here");
    expect(closed).not.toContain(SEARCH_MARKER);
  });

  it("walks older and newer matches and expands collapsed output to show one", async () => {
    const { setup, bridge } = await inConversation({ height: 40 });
    bridge.emit({ type: "tool_execution_start", toolName: "bash", toolCallId: "b1", args: { command: "ls" } });
    bridge.emit({ type: "tool_execution_end", toolName: "bash", toolCallId: "b1", result: toolResult(lines(30, "row")) });
    bridge.emit({ type: "assistant_delta", text: "alpha one" });
    bridge.emit({ type: "agent_end" });
    await setup.waitForFrame((text) => text.includes("alpha one") && text.includes("Show 18 more lines"));

    openSearch(setup);
    await setup.waitForFrame((text) => text.includes("Search the transcript"));
    await setup.mockInput.typeText("row 2");
    // "row 2" and "row 20".."row 29": the newest is "row 29", past the collapse.
    const newest = await setup.waitForFrame((text) => text.includes("11/11") && text.includes("row 29"));
    expect(newest).toContain("Show less");

    setup.mockInput.pressEnter();
    await setup.waitForFrame((text) => text.includes("10/11"));
    setup.mockInput.pressArrow("down");
    await setup.waitForFrame((text) => text.includes("11/11"));
    setup.mockInput.pressArrow("down");
    await setup.waitForFrame((text) => text.includes("1/11"));
    expect(bridge.runs).toHaveLength(1);
  });

  it("keeps the composer draft and never sends search keys to it", async () => {
    const { setup, bridge } = await inConversation();
    bridge.emit({ type: "assistant_delta", text: "some reply" });
    bridge.emit({ type: "agent_end" });
    await setup.waitForFrame((text) => text.includes("some reply") && text.includes("Ask CrewCoder"));
    await setup.mockInput.typeText("my draft");
    await setup.waitForFrame((text) => text.includes("my draft"));

    openSearch(setup);
    await setup.waitForFrame((text) => text.includes("Find"));
    await setup.mockInput.typeText("nothing here");
    const none = await setup.waitForFrame((text) => text.includes("No matches"));
    expect(none).toContain("0/0");
    setup.mockInput.pressEnter();

    const back = await closeSearch(setup, (text) => text.includes("my draft") && !text.includes("No matches"));
    expect(back).not.toContain("nothing here");
    expect(bridge.runs).toHaveLength(1);
  });

  it("opens with /find <text>, and says there is nothing to search on the welcome screen", async () => {
    const { setup, bridge } = await inConversation({}, "find the haystack");
    bridge.emit({ type: "agent_end" });
    await setup.waitForFrame((text) => text.includes("find the haystack") && text.includes("Ask CrewCoder"));
    await setup.mockInput.typeText("/find haystack");
    setup.mockInput.pressEnter();
    await setup.waitForFrame((text) => text.includes("1/1"));

    const home = await renderApp();
    openSearch(home.setup);
    await home.setup.waitForFrame((text) => text.includes("Nothing to search yet"));
  });
});

describe("keys", () => {
  it("aborts the running request on escape and quits on ctrl+c", async () => {
    const { setup, bridge, onQuit } = await inConversation({}, "long");
    await setup.renderOnce();

    setup.mockInput.pressEscape();
    // A lone ESC is delivered after the parser's escape-sequence timeout.
    await vi.waitFor(() => expect(bridge.stops).toBe(1), { timeout: 2_000 });

    setup.mockInput.pressKey("c", { ctrl: true });
    expect(onQuit).toHaveBeenCalledTimes(1);
  });

  it("ignores keys and pastes while the terminal is unfocused, and takes them again on focus", async () => {
    // As in cli.tsx: Ctrl+C reaches the app instead of the renderer exiting on its own.
    const { setup, bridge, onQuit } = await renderApp(new FakeCli(), { exitOnCtrlC: false });
    await setup.waitForFrame((text) => text.includes("Ask CrewCoder"));

    act(() => {
      setup.renderer.emit("blur");
    });
    await setup.mockInput.typeText("ghost");
    await setup.mockInput.pasteBracketedText("pasted ghost");
    setup.mockInput.pressEnter();
    setup.mockInput.pressKey("c", { ctrl: true });
    await setup.renderOnce();
    expect(bridge.runs).toHaveLength(0);
    expect(onQuit).not.toHaveBeenCalled();

    act(() => {
      setup.renderer.emit("focus");
    });
    await setup.mockInput.typeText("real");
    await setup.mockInput.pasteBracketedText(" text");
    // Had any blurred key or paste landed, "ghost" would sit in front of this text.
    const focused = await setup.waitForFrame((text) => text.includes("real text"));
    expect(focused).not.toContain("ghost");
    setup.mockInput.pressEnter();
    expect(bridge.runs.at(-1)).toMatchObject({ prompt: "real text" });
  });
});

describe("welcome screen", () => {
  it("centers the logo with the composer on a fresh session and leaves on the first prompt", async () => {
    const { setup, bridge } = await renderApp();
    const frame = await setup.waitForFrame((text) => text.includes("Type your first request"));
    const rows = frame.split("\n");
    const logoRow = rows.findIndex((line) => line.includes("██████"));

    expect(logoRow).toBeGreaterThan(0);
    // Centered horizontally: equal margins within one column.
    const logoLine = rows[logoRow] ?? "";
    const left = logoLine.length - logoLine.trimStart().length;
    const right = logoLine.length - logoLine.trimEnd().length;
    expect(Math.abs(left - right)).toBeLessThanOrEqual(1);
    // Centered vertically: blank rows above the logo.
    expect(rows.slice(0, logoRow).every((line) => line.trim() === "")).toBe(true);
    expect(frame).toContain("Ask CrewCoder");

    await setup.mockInput.typeText("hello");
    setup.mockInput.pressEnter();
    expect(bridge.runs).toHaveLength(1);
    const after = await setup.waitForFrame((text) => text.includes("Working"));
    expect(after).not.toContain("██████");
  });

  describe("logo pulse", () => {
    let clock = 0;
    beforeEach(() => {
      clock = 0;
      vi.spyOn(Date, "now").mockImplementation(() => clock);
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    async function renderHome(reduced: boolean): Promise<Setup> {
      const controller = new SessionController(new FakeBridge(), undefined, new FakeCli(), undefined, undefined, undefined, async () => DISABLED_TASKS);
      const setup = await testRender(
        <MotionContext.Provider value={{ reduced }}>
          <AppThemeProvider theme={slateAppTheme}>
            <App controller={controller} onQuit={vi.fn()} />
          </AppThemeProvider>
        </MotionContext.Provider>,
        { width: 80, height: 24 }
      );
      active = setup;
      await setup.renderOnce();
      return setup;
    }

    const logoColor = (setup: Setup) => setup.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.includes("██"))?.fg;

    /** Waits for the pulse timer to repaint the logo in `hex` (Date.now is mocked, so the deadline uses performance). */
    async function waitForLogo(setup: Setup, hex: string): Promise<void> {
      const color = RGBA.fromHex(hex);
      const deadline = performance.now() + 4_000;
      for (;;) {
        await setup.renderOnce();
        if (logoColor(setup)?.equals(color)) return;
        if (performance.now() > deadline) throw new Error(`logo never drew in ${hex}`);
        await new Promise((resolve) => setTimeout(resolve, PULSE_FRAME_MS));
      }
    }

    it("breathes between the dim accent and the glow color, then freezes when idle and resumes on a key", async () => {
      const { logo } = slateAppTheme;
      const setup = await renderHome(false);
      clock = PULSE_PERIOD_MS / 4;
      await waitForLogo(setup, logo.bright);
      clock = (PULSE_PERIOD_MS * 3) / 4;
      await waitForLogo(setup, logo.dim);

      // Idle past the limit: the frame at the freeze instant stays, whatever the clock does.
      const frozen = logoPulseColor(logo, PULSE_FREEZE_MS);
      expect([logo.dim, logo.bright]).not.toContain(frozen);
      // A whole number of breaths past the limit, so the offsets below land on peak and trough.
      const base = Math.ceil(PULSE_FREEZE_MS / PULSE_PERIOD_MS) * PULSE_PERIOD_MS;
      clock = base + PULSE_PERIOD_MS / 4;
      await waitForLogo(setup, frozen);
      clock = base + (PULSE_PERIOD_MS * 3) / 4;
      await new Promise((resolve) => setTimeout(resolve, PULSE_FRAME_MS * 3));
      await setup.renderOnce();
      expect(logoColor(setup)?.equals(RGBA.fromHex(frozen))).toBe(true);

      // A key restarts it.
      await setup.mockInput.typeText("a");
      await waitForLogo(setup, logo.dim);
      clock += PULSE_PERIOD_MS / 2;
      await waitForLogo(setup, logo.bright);
    });

    it("stays on the glow color under reduced motion", async () => {
      const setup = await renderHome(true);
      expect(logoColor(setup)?.equals(RGBA.fromHex(slateAppTheme.logo.bright))).toBe(true);
      clock = (PULSE_PERIOD_MS * 3) / 4;
      await new Promise((resolve) => setTimeout(resolve, PULSE_FRAME_MS * 3));
      await setup.renderOnce();
      expect(logoColor(setup)?.equals(RGBA.fromHex(slateAppTheme.logo.bright))).toBe(true);
    });
  });

  it("shows only the composer, no logo, on a small window", async () => {
    const { setup } = await renderApp(new FakeCli(), { width: 60 });
    const frame = await setup.waitForFrame((text) => text.includes("Type your first request"));
    expect(frame).not.toContain("█");
    expect(frame).not.toContain("CREW CODER");
    expect(frame).toContain("Ask CrewCoder");
  });

  it("returns after /new", async () => {
    const { setup, bridge } = await inConversation();
    bridge.emit({ type: "agent_end" });
    await setup.waitForFrame((text) => !text.includes("Type your first request"));

    await setup.mockInput.typeText("/new");
    setup.mockInput.pressEnter();
    await setup.waitForFrame((text) => text.includes("Type your first request"));
  });
});

describe("pickers", () => {
  it("opens the palette below the conversation and closes it on escape", async () => {
    const { setup, bridge, controller } = await inConversation({}, "first prompt");
    bridge.emit({ type: "agent_end" });
    await setup.waitForFrame((text) => text.includes("Ask CrewCoder") && !text.includes("Type your first request"));

    await setup.mockInput.typeText("/");
    const frame = await setup.waitForFrame((text) => text.includes("Esc close") && text.includes("╰"));
    expect(frame).toContain("/sessions");
    expect(frame).toContain("first prompt");
    expect(frame).toMatch(/1\/\d+/);

    setup.mockInput.pressEscape();
    await vi.waitFor(() => expect(controller.picker).toBeUndefined(), { timeout: 2_000 });
    await setup.waitForFrame((text) => text.includes("Ask CrewCoder"));
    expect(bridge.stops).toBe(0);
  });

  it("/sessions shows Tab branch; letters still search, and Tab opens a branch of the highlighted session", async () => {
    const cli = new FakeCli();
    cli.sessionList = [
      { id: "s-1", startedAt: "2026-11-15T10:00:00Z", cwd: "/r", requestedMode: "general", resolvedMode: "general", prompt: "alpha work" },
      { id: "s-2", startedAt: "2026-11-15T11:00:00Z", cwd: "/r", requestedMode: "general", resolvedMode: "general", prompt: "beta work" }
    ];
    cli.branchResult = "s-2-fork";
    const { setup, bridge, controller } = await renderApp(cli);
    await setup.mockInput.typeText("/sessions");
    setup.mockInput.pressEnter();
    await flush();
    await setup.waitForFrame((text) => text.includes("Tab branch") && text.includes("beta work"));
    // "b" searches; it does not branch (legacy used a bare b).
    await setup.mockInput.typeText("beta");
    await vi.waitFor(() => expect(controller.pickerQuery).toBe("beta"));
    expect(cli.branches).toEqual([]);
    setup.mockInput.pressTab();
    await flush();
    await vi.waitFor(() => expect(bridge.resumes).toEqual([expect.objectContaining({ sessionId: "s-2-fork" })]));
    expect(cli.branches).toEqual(["s-2"]);
    expect(controller.picker).toBeUndefined();
  });

  it("puts a chosen prompt command into the composer", async () => {
    const cli = new FakeCli()
      .json("command list --json", [{ name: "review", path: "/x/review.md" }])
      .json("command show review --json", { content: "Review the diff" });
    const { setup, bridge } = await renderApp(cli);

    await setup.mockInput.typeText("/commands");
    setup.mockInput.pressEnter();
    await flush();
    await setup.waitForFrame((text) => text.includes("review") && text.includes("Insert prompt command"));
    setup.mockInput.pressEnter();
    await flush();
    await setup.waitForFrame((text) => text.includes("Review the diff"));

    setup.mockInput.pressEnter();
    expect(bridge.runs).toEqual([expect.objectContaining({ prompt: "Review the diff" })]);
  });
});

describe("multi-line composer", () => {
  async function idle(options: { kittyKeyboard?: boolean } = {}) {
    const rendered = await inConversation(options);
    rendered.bridge.emit({ type: "agent_end" });
    await rendered.setup.waitForFrame((text) => text.includes("Ask CrewCoder") && !text.includes("Type your first request"));
    return rendered;
  }

  /** The composer's text row (one-line composer: border rows 20 and 22, status 23). */
  const composerRow = (frame: string): string => frame.split("\n")[21] ?? "";

  it("Up/Down recall this session's sent messages and restore the draft", async () => {
    const { setup, bridge } = await idle(); // sent "hi"
    await setup.mockInput.typeText("second prompt");
    setup.mockInput.pressEnter();
    bridge.emit({ type: "agent_end" });
    await setup.waitForFrame((text) => composerRow(text).includes("Ask CrewCoder"));

    await setup.mockInput.typeText("my draft");
    setup.mockInput.pressArrow("up");
    await setup.waitForFrame((text) => composerRow(text).includes("second prompt"));
    setup.mockInput.pressArrow("up");
    await setup.waitForFrame((text) => composerRow(text).includes("hi") && !composerRow(text).includes("second"));
    // Past the oldest message, Up does nothing.
    setup.mockInput.pressArrow("up");
    await setup.renderOnce();
    expect(composerRow(await setup.waitForFrame(() => true))).toContain("hi");

    setup.mockInput.pressArrow("down");
    await setup.waitForFrame((text) => composerRow(text).includes("second prompt"));
    setup.mockInput.pressArrow("down");
    await setup.waitForFrame((text) => composerRow(text).includes("my draft"));

    // A recalled message can be sent as is.
    setup.mockInput.pressArrow("up");
    await setup.waitForFrame((text) => composerRow(text).includes("second prompt"));
    setup.mockInput.pressEnter();
    expect(bridge.runs.at(-1)).toMatchObject({ prompt: "second prompt" });
  });

  it("Up moves between a multi-line draft's lines before recalling", async () => {
    const { setup, bridge, controller } = await idle({ kittyKeyboard: true }); // sent "hi"
    await setup.mockInput.typeText("line one");
    setup.mockInput.pressEnter({ shift: true });
    await setup.mockInput.typeText("line two");
    await vi.waitFor(() => expect(controller.composerLines).toBe(2));

    // First Up: cursor moves to line one, nothing is recalled.
    setup.mockInput.pressArrow("up");
    await setup.renderOnce();
    const moved = await setup.waitForFrame((text) => text.includes("line one"));
    expect(moved).toContain("line two");
    // Second Up: on the first line, so the sent message comes back.
    setup.mockInput.pressArrow("up");
    await setup.waitForFrame((text) => !text.includes("line two"));
    setup.mockInput.pressEnter();
    expect(bridge.runs.at(-1)).toMatchObject({ prompt: "hi" });
  });

  it("Shift+Enter adds a line and Enter sends every line", async () => {
    const { setup, bridge, controller } = await idle({ kittyKeyboard: true });
    await setup.mockInput.typeText("first line");
    setup.mockInput.pressEnter({ shift: true });
    await setup.mockInput.typeText("second line");
    await vi.waitFor(() => expect(controller.composerLines).toBe(2));
    const frame = await setup.waitForFrame((text) => text.includes("second line"));
    expect(frame).toContain("first line");

    setup.mockInput.pressEnter();
    expect(bridge.runs.at(-1)).toMatchObject({ prompt: "first line\nsecond line" });
    await vi.waitFor(() => expect(controller.composerLines).toBe(1));
  });

  it("Ctrl+J adds a line without the kitty keyboard protocol", async () => {
    const { setup, bridge } = await idle();
    await setup.mockInput.typeText("a");
    setup.mockInput.pressKey("j", { ctrl: true });
    await setup.mockInput.typeText("b");
    setup.mockInput.pressEnter();
    expect(bridge.runs.at(-1)).toMatchObject({ prompt: "a\nb" });
  });
});

describe("@ path suggestions", () => {
  const PATHS: readonly PathSuggestion[] = [
    { path: "src/", type: "directory" },
    { path: "src/app.ts", type: "file" },
    { path: "src/cli.tsx", type: "file" },
    { path: "README.md", type: "file" }
  ];

  // Like the real walker: a directory is not suggested for its own path (`src/` for "src/").
  const fakeLister: PathLister = async (_cwd, query) => PATHS.filter((entry) => entry.path !== query && entry.path.toLowerCase().startsWith(query.toLowerCase()));

  async function withPaths(listPaths: PathLister | null = fakeLister) {
    const bridge = new FakeBridge();
    const controller = new SessionController(bridge, undefined, new FakeCli(), async () => "", listPaths);
    const setup = await testRender(
      <ThemeProvider theme={slateTheme}><App controller={controller} onQuit={() => {}} /></ThemeProvider>,
      { width: 80, height: 30 }
    );
    active = setup;
    await setup.renderOnce();
    return { setup, bridge, controller };
  }

  it("lists matching paths under the composer and inserts the picked one", async () => {
    const { setup, bridge } = await withPaths();
    await setup.mockInput.typeText("look at @src");
    const open = await setup.waitForFrame((text) => text.includes("src/cli.tsx"));
    expect(open).toContain("▸ src/");
    expect(open).not.toContain("README.md");
    const rows = open.split("\n");
    expect(rows.findIndex((row) => row.includes("src/cli.tsx"))).toBeGreaterThan(rows.findIndex((row) => row.includes("look at @src")));

    setup.mockInput.pressArrow("down");
    await setup.waitForFrame((text) => text.includes("▸ src/app.ts"));
    setup.mockInput.pressEnter();
    await setup.waitForFrame((text) => text.includes("look at @src/app.ts") && !text.includes("src/cli.tsx"));
    // Enter picked the path; it did not send the prompt.
    expect(bridge.runs).toEqual([]);

    await setup.mockInput.typeText("please");
    setup.mockInput.pressEnter();
    expect(bridge.runs.at(-1)).toMatchObject({ prompt: "look at @src/app.ts please" });
  });

  it("keeps a picked directory open for its contents, and Tab picks too", async () => {
    const { setup, bridge } = await withPaths();
    await setup.mockInput.typeText("@s");
    await setup.waitForFrame((text) => text.includes("▸ src/"));
    setup.mockInput.pressTab();
    // "@src/" stays a token, so its files are suggested next.
    await setup.waitForFrame((text) => text.includes("▸ src/app.ts"));
    setup.mockInput.pressTab();
    await setup.mockInput.typeText("x");
    setup.mockInput.pressEnter();
    expect(bridge.runs.at(-1)).toMatchObject({ prompt: "@src/app.ts x" });
  });

  it("Esc closes the list without aborting, and Enter on no matches sends", async () => {
    const { setup, bridge, controller } = await withPaths();
    await setup.mockInput.typeText("go");
    setup.mockInput.pressEnter();
    bridge.emit({ type: "agent_start", sessionId: "s1" });
    await setup.waitForFrame((text) => text.includes("Send a follow-up"));
    await setup.mockInput.typeText("@READ");
    await setup.waitForFrame((text) => text.includes("▸ README.md"));
    setup.mockInput.pressEscape();
    // A lone ESC is delivered after the parser's escape-sequence timeout.
    await vi.waitFor(() => expect(controller.mention).toBeUndefined(), { timeout: 2_000 });
    await setup.waitForFrame((text) => !text.includes("▸ README.md"));
    expect(bridge.stops).toBe(0);
    expect(controller.state.running).toBe(true);

    await setup.mockInput.typeText("zz");
    await setup.waitForFrame((text) => text.includes(MENTION_EMPTY_TEXT));
    setup.mockInput.pressEnter();
    expect(bridge.followUps.at(-1)).toBe("@READzz");
  });

  // Wide (CJK) characters before the token. The mock keyboard types one UTF-16
  // unit at a time, so it cannot type an emoji; a paste delivers it whole.
  it("finds the token after wide characters and pasted emoji", async () => {
    const { setup, bridge } = await withPaths();
    await setup.mockInput.typeText("é中文");
    await setup.mockInput.pasteBracketedText("😀");
    await setup.mockInput.typeText(" see @READ");
    await setup.waitForFrame((text) => text.includes("▸ README.md"));
    setup.mockInput.pressEnter();
    await setup.mockInput.typeText("now");
    setup.mockInput.pressEnter();
    expect(bridge.runs.at(-1)).toMatchObject({ prompt: "é中文😀 see @README.md now" });
  });

  it("never lists paths in remote mode or for an email address", async () => {
    const lister = vi.fn<PathLister>(async () => [...PATHS]);
    const remote = await withPaths(null);
    await remote.setup.mockInput.typeText("@src");
    await remote.setup.renderOnce();
    expect(remote.controller.mention).toBeUndefined();
    await remote.setup.dispose();

    const local = await withPaths(lister);
    await local.setup.mockInput.typeText("mail me@src");
    await local.setup.renderOnce();
    expect(lister).not.toHaveBeenCalled();
  });
});

describe("composer shortcuts", () => {
  let restoreCache: () => void;
  beforeEach(() => {
    restoreCache = isolateImageCache();
  });
  afterEach(() => restoreCache());

  async function withClipboard(clipboard: ClipboardSource) {
    const bridge = new FakeBridge();
    const controller = new SessionController(bridge, undefined, new FakeCli(), async () => "", null, clipboard);
    const setup = await testRender(
      <ThemeProvider theme={slateTheme}><App controller={controller} onQuit={() => {}} /></ThemeProvider>,
      { width: 80, height: 30 }
    );
    active = setup;
    await setup.renderOnce();
    return { setup, bridge, controller };
  }

  it("Ctrl+V attaches a clipboard image, Enter sends it alone, and the transcript shows it", async () => {
    const { setup, bridge } = await withClipboard(fakeClipboard({ image: pngBytes(800, 600) }));
    setup.mockInput.pressKey("v", { ctrl: true });
    const attached = await setup.waitForFrame((text) => text.includes("IMG 1"));
    expect(attached).toContain("800×600");
    expect(attached).toContain("^X clear");

    setup.mockInput.pressEnter();
    expect(bridge.runs).toHaveLength(1);
    expect(bridge.runs[0]!.images).toHaveLength(1);
    expect(bridge.runs[0]!.images![0]!.startsWith(process.env.CREWCODER_HOME!)).toBe(true);
    const sent = await setup.waitForFrame((text) => text.includes("(image attached)"));
    expect(sent).toContain("IMAGE");
    expect(sent).not.toContain("IMG 1");
  });

  it("Ctrl+X clears pending images; Ctrl+V pastes clipboard text when there is no image", async () => {
    const { setup, bridge, controller } = await withClipboard(fakeClipboard({ image: pngBytes() }));
    setup.mockInput.pressKey("v", { ctrl: true });
    await setup.waitForFrame((text) => text.includes("IMG 1"));
    setup.mockInput.pressKey("x", { ctrl: true });
    await setup.waitForFrame((text) => !text.includes("IMG 1"));
    expect(controller.state.attachments).toEqual([]);

    const text = await withClipboard(fakeClipboard({ text: "from clipboard" }));
    text.setup.mockInput.pressKey("v", { ctrl: true });
    await text.setup.waitForFrame((frame) => frame.includes("from clipboard"));
    text.setup.mockInput.pressEnter();
    expect(text.bridge.runs.at(-1)).toMatchObject({ prompt: "from clipboard", images: [] });
    expect(bridge.runs).toEqual([]);
  });

  it("attaches an image path typed or dropped into the prompt and keeps the text", async () => {
    const file = pngFile("drop.png");
    const { setup, bridge } = await withClipboard(fakeClipboard());
    await setup.mockInput.pasteBracketedText(`what is in ${file}`);
    setup.mockInput.pressEnter();
    expect(bridge.runs.at(-1)).toMatchObject({ prompt: `what is in ${file}` });
    expect(bridge.runs.at(-1)!.images).toHaveLength(1);
  });

  it("Ctrl+P toggles the palette and keeps the draft; Tab opens the modes picker", async () => {
    const { setup, controller } = await withClipboard(fakeClipboard());
    await setup.mockInput.typeText("half typed");
    setup.mockInput.pressKey("p", { ctrl: true });
    await setup.waitForFrame((text) => text.includes("Search commands"));
    expect(controller.picker?.kind).toBe("commands");
    setup.mockInput.pressKey("p", { ctrl: true });
    await setup.waitForFrame((text) => text.includes("half typed") && !text.includes("Search commands"));

    setup.mockInput.pressTab();
    await setup.waitForFrame((text) => text.includes("Mode or worker"));
    expect(controller.picker?.kind).toBe("mode");
  });
});

describe("inline images", () => {
  const RED = RGBA.fromHex("#ff0000");
  let restoreEnv: string | undefined;
  beforeEach(() => {
    restoreEnv = process.env[IMAGE_PROTOCOL_ENV];
  });
  afterEach(() => {
    if (restoreEnv === undefined) delete process.env[IMAGE_PROTOCOL_ENV];
    else process.env[IMAGE_PROTOCOL_ENV] = restoreEnv;
  });

  /** Rows (index) holding image cells: the test renderer has no graphics protocol, so `auto` draws half-blocks. */
  function redRows(setup: Setup): number[] {
    return setup.captureSpans().lines.flatMap((line, index) => (line.spans.some((span) => span.bg.equals(RED) && span.text.trim() !== "") ? [index] : []));
  }

  async function waitForRedRows(setup: Setup): Promise<number[]> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      await setup.renderOnce();
      const rows = redRows(setup);
      if (rows.length > 0) return rows;
      if (Date.now() > deadline) throw new Error("the image never drew");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  const toolImage = (file: string) => ({
    type: "tool_execution_end",
    toolName: "screenshot",
    toolCallId: "img-1",
    result: toolResult("captured"),
    metadata: { images: [{ path: file, displayPath: "shot.png" }] }
  });

  it("draws a tool-result image between its caption and path, sized by its shape", async () => {
    const file = solidPngFile("shot.png", 400, 100, [255, 0, 0]);
    const { setup, bridge } = await inConversation({ width: 80, height: 40 });
    bridge.emit({ type: "tool_execution_start", toolName: "screenshot", toolCallId: "img-1", args: {} });
    bridge.emit(toolImage(file));
    const rows = await waitForRedRows(setup);
    const frame = setup.captureCharFrame().split("\n");
    const label = frame.findIndex((line) => line.includes("TOOL IMAGE"));
    expect(frame[label + 1]).toContain("shot.png · 400×100");
    // 4:1 pixels in 2:1 cells: 77 usable columns -> 10 rows (40 * 0.35 = 14 allowed).
    expect(rows).toEqual(Array.from({ length: 10 }, (_, index) => label + 2 + index));
    expect(frame[label + 12]).toContain("shot.png");
    expect(setup.captureCharFrame()).not.toContain(IMAGE_FAILED_TEXT);
  });

  it("keeps the caption and says so when the file cannot be decoded", async () => {
    const file = pngFile("broken.png", 300, 200);
    const { setup, bridge } = await inConversation({ height: 30 });
    bridge.emit(toolImage(file));
    const frame = await setup.waitForFrame((text) => text.includes(IMAGE_FAILED_TEXT));
    expect(frame).toContain("TOOL IMAGE");
    expect(frame).toContain("300×200");
  });

  it("draws no pixels with CREWCODER_TUI_IMAGE_PROTOCOL=none", async () => {
    process.env[IMAGE_PROTOCOL_ENV] = "none";
    const file = solidPngFile("shot.png", 400, 100, [255, 0, 0]);
    const { setup, bridge } = await inConversation({ height: 30 });
    bridge.emit(toolImage(file));
    await setup.waitForFrame((text) => text.includes("TOOL IMAGE"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    await setup.renderOnce();
    expect(redRows(setup)).toEqual([]);
    expect(setup.captureCharFrame()).not.toContain(IMAGE_FAILED_TEXT);
  });

  it("draws a pasted image in the transcript after sending", async () => {
    const restore = isolateImageCache();
    try {
      const bridge = new FakeBridge();
      const clipboard = fakeClipboard({ image: solidPng(64, 64, [255, 0, 0]) });
      const controller = new SessionController(bridge, undefined, new FakeCli(), undefined, null, clipboard, async () => DISABLED_TASKS);
      const setup = await testRender(
        <AppThemeProvider theme={slateAppTheme}>
          <App controller={controller} onQuit={vi.fn()} />
        </AppThemeProvider>,
        { width: 80, height: 30 }
      );
      active = setup;
      await setup.renderOnce();
      setup.mockInput.pressKey("v", { ctrl: true });
      await setup.waitForFrame((text) => text.includes("IMG 1"));
      setup.mockInput.pressEnter();
      expect(await waitForRedRows(setup)).toHaveLength(10);
    } finally {
      restore();
    }
  });
});

describe("alerts", () => {
  it("shows a command result above the composer until the next key", async () => {
    const cli = new FakeCli();
    cli.json("config show", { thinkingEnabled: true });
    const { setup, bridge, controller } = await renderApp(cli);
    await setup.mockInput.typeText("hi");
    setup.mockInput.pressEnter();
    bridge.emit({ type: "agent_end" });
    await setup.waitForFrame((text) => text.includes("Ask CrewCoder") && !text.includes("Type your first request"));

    controller.submit("/thinking status");
    await flush();
    const frame = await setup.waitForFrame((text) => text.includes("Provider thinking: on"));
    const rows = frame.split("\n");
    expect(rows.findIndex((line) => line.includes("Provider thinking: on"))).toBeLessThan(rows.findIndex((line) => line.includes("Ask CrewCoder")));

    await setup.mockInput.typeText("x");
    await setup.waitForFrame((text) => !text.includes("Provider thinking: on"));
    expect(controller.currentAlert).toBeUndefined();
  });
});

describe("compaction summary editor", () => {
  it("edits the summary and applies it with Ctrl+S", async () => {
    const { setup, bridge, controller } = await inConversation({}, "long task");
    bridge.emit({ type: "session_compaction_preview", previewId: "p-1", summary: "proposed summary" });
    await setup.waitForFrame((text) => text.includes("Edit compaction summary") && text.includes("proposed summary"));

    await setup.mockInput.typeText(" plus");
    setup.mockInput.pressKey("s", { ctrl: true });
    await vi.waitFor(() => expect(bridge.previewResolutions).toHaveLength(1));
    expect(bridge.previewResolutions[0]).toMatchObject({ previewId: "p-1", approved: true });
    // The cursor opens after the summary, so typing appends.
    expect(bridge.previewResolutions[0]?.summary).toBe("proposed summary plus");
    expect(controller.editor).toBeUndefined();
  });
});

describe("extension questions", () => {
  async function asked(event: Record<string, unknown>, draft = "") {
    const rendered = await inConversation({}, "go");
    if (draft) await rendered.setup.mockInput.typeText(draft);
    rendered.bridge.emit({ type: "extension_ui_request", requestId: "q-1", extensionId: "ext.secret-id", ...event });
    return rendered;
  }

  it("answers a select with the original option value and records the outcome", async () => {
    const { setup, bridge, controller } = await asked({
      uiKind: "select",
      title: "Which cache strategy should the build use for this repository?",
      options: [
        { label: "Local", value: "local-disk", description: "Fastest on one machine" },
        { label: "Remote", value: "remote-s3", description: "Shared across CI runners" }
      ]
    });
    const frame = await setup.waitForFrame((text) => text.includes("Which cache strategy"));
    expect(frame).toContain("Shared across CI runners");
    expect(frame).not.toContain("ext.secret-id");
    expect(frame).not.toContain("q-1");

    setup.mockInput.pressArrow("down");
    await setup.renderOnce();
    setup.mockInput.pressEnter();
    await setup.renderOnce();
    expect(bridge.uiResponses).toEqual([{ requestId: "q-1", value: "remote-s3" }]);
    expect(controller.question()).toBeUndefined();

    bridge.emit({ type: "extension_ui_resolved", requestId: "q-1" });
    bridge.emit({ type: "agent_end" });
    const after = await setup.waitForFrame((text) => text.includes("QUESTION · answered"));
    expect(after).toContain("Answer: remote-s3");
  });

  it("answers a confirm with y, and its keys never reach the composer", async () => {
    const { setup, bridge } = await asked({ uiKind: "confirm", title: "Overwrite the lockfile?" });
    await setup.waitForFrame((text) => text.includes("Overwrite the lockfile?") && text.includes("Yes"));
    setup.mockInput.pressKey("y");
    await setup.renderOnce();
    expect(bridge.uiResponses).toEqual([{ requestId: "q-1", value: true }]);
    const frame = await setup.waitForFrame((text) => text.includes("Send a follow-up"));
    expect(frame).not.toMatch(/│\s*y\s/);
  });

  it("sends typed text for an input and restores the composer draft afterwards", async () => {
    const { setup, bridge, controller } = await asked({ uiKind: "input", title: "Name the release branch", defaultValue: "release/" }, "half typed");
    await setup.waitForFrame((text) => text.includes("Name the release branch"));
    await setup.mockInput.typeText("1.2");
    setup.mockInput.pressEnter();
    await setup.renderOnce();
    expect(bridge.uiResponses).toEqual([{ requestId: "q-1", value: "release/1.2" }]);
    expect(bridge.followUps).toEqual([]);
    expect(controller.question()).toBeUndefined();
    // The card is gone (the transcript keeps the question as a record) and the draft is back.
    const frame = await setup.waitForFrame((text) => text.includes("half typed"));
    expect(frame).toContain("QUESTION · answered");
    expect(frame).not.toContain("Enter send · Esc cancel");
  });

  it("cancels with escape instead of aborting the run", async () => {
    const { setup, bridge } = await asked({ uiKind: "select", title: "Pick one", options: [{ label: "A", value: "a" }] });
    await setup.waitForFrame((text) => text.includes("Pick one"));
    setup.mockInput.pressEscape();
    await vi.waitFor(() => expect(bridge.uiResponses).toEqual([{ requestId: "q-1", value: null }]), { timeout: 2_000 });
    expect(bridge.stops).toBe(0);
  });

  it("chooses an option with a mouse click", async () => {
    const { setup, bridge } = await asked({ uiKind: "select", title: "Pick one", options: [{ label: "Alpha", value: "a" }, { label: "Bravo", value: "b" }] });
    const frame = await setup.waitForFrame((text) => text.includes("Bravo"));
    const rows = frame.split("\n");
    const row = rows.findIndex((line) => line.includes("Bravo"));
    await setup.mockMouse.click(rows[row]!.indexOf("Bravo"), row);
    await setup.renderOnce();
    expect(bridge.uiResponses).toEqual([{ requestId: "q-1", value: "b" }]);
  });
});

describe("right sidebar", () => {
  const sidebarText = (frame: string, width: number): string[] => frame.split("\n").map((row) => row.slice(-width).trimEnd());

  it("Ctrl+B opens it beside the conversation; Ctrl+B closes it and the transcript gets the width back", async () => {
    const { setup, bridge, controller } = await inConversation({ width: 100 }, "hello");
    Object.assign(controller.state, { cwd: "/work/app", gitLabel: "main*" });
    bridge.emit({ type: "file_changed", path: "/work/app/src/app.ts" });
    setup.mockInput.pressKey("b", { ctrl: true });
    const open = await setup.waitForFrame((text) => text.includes("MODIFIED FILES"));
    const side = sidebarText(open, 26);
    expect(side[0]).toBe("  MODIFIED FILES 1");
    expect(side[1]).toBe("  ● src/app.ts");
    expect(side.at(-2)).toBe("  • CrewCoder");
    expect(side).toContain("  /work/app:main*");
    // The divider sits just left of the sidebar; the composer ends before it.
    const rows = open.split("\n");
    expect(rows.filter(Boolean).every((row) => row[100 - 27] === "│")).toBe(true);
    expect(rows.find((row) => row.includes("╰"))?.lastIndexOf("╯")).toBeLessThan(100 - 27);
    expect(controller.state.blocks.filter((block) => block.type === "user")).toHaveLength(1);

    setup.mockInput.pressKey("b", { ctrl: true });
    const closed = await setup.waitForFrame((text) => !text.includes("MODIFIED FILES"));
    expect(closed.split("\n").find((row) => row.includes("╰"))?.lastIndexOf("╯")).toBeGreaterThan(100 - 27);
  });

  it("shows this session's crew tasks and live crew agents", async () => {
    const readTasks: TaskReader = async () => ({ enabled: true, tasks: [
      { id: "1", subject: "Plan", status: "completed", sessionId: "s-1" },
      { id: "2", subject: "Build", status: "in_progress", activeForm: "Building the sidebar", sessionId: "s-1" }
    ] });
    const { setup, bridge, controller } = await renderApp(new FakeCli(), { width: 120, readTasks });
    await setup.mockInput.typeText("go");
    setup.mockInput.pressEnter();
    bridge.emit({ type: "agent_start", sessionId: "s-1" });
    bridge.emit({ type: "crew_start", workers: ["builder", "tester"] });
    bridge.emit({ type: "crew_worker_start", worker: "builder" });
    controller.sidebar.setOpen(true);
    const frame = await setup.waitForFrame((text) => text.includes("CREW TASKS") && text.includes("AGENTS: builder"));
    const side = sidebarText(frame, 31);
    expect(side).toContain("  CREW TASKS — 1/2 completed");
    expect(side).toContain("  ◉ 2. Building the sidebar");
    expect(side).toContain("  ✓ 1. Plan");
    expect(side.some((row) => /^ {2}\S builder running$/.test(row))).toBe(true);
    expect(side).toContain("  □ tester queued");
  });

  it("stays hidden below 60 columns and on the welcome screen keeps the logo when there is room", async () => {
    const narrow = await renderApp(new FakeCli(), { width: 58 });
    narrow.setup.mockInput.pressKey("b", { ctrl: true });
    await narrow.setup.renderOnce();
    expect(narrow.controller.sidebar.open).toBe(true);
    expect(narrow.setup.captureCharFrame()).not.toContain("MODIFIED FILES");
    await narrow.setup.dispose();

    const wide = await renderApp(new FakeCli(), { width: 130, height: 30 });
    wide.controller.sidebar.setOpen(true);
    const frame = await wide.setup.waitForFrame((text) => text.includes("MODIFIED FILES"));
    expect(frame).toContain("██");
    expect(frame).toContain("Ask CrewCoder");
    active = wide.setup;
  });

  it("dragging the divider resizes it within bounds", async () => {
    const { setup, controller } = await inConversation({ width: 100 }, "hello");
    controller.sidebar.setOpen(true);
    await setup.waitForFrame((text) => text.includes("MODIFIED FILES"));
    const divider = 100 - 27;
    await setup.mockMouse.drag(divider, 5, divider - 14, 5);
    await setup.waitForFrame((text) => text.split("\n").filter(Boolean).every((row) => row[100 - 41] === "│"));
    expect(controller.sidebar.columns(100)).toBe(40);
    await setup.mockMouse.drag(100 - 41, 5, 2, 5);
    // Capped at 60 columns (and never leaving the conversation under 32).
    await setup.waitForFrame((text) => text.split("\n").filter(Boolean).every((row) => row[100 - 61] === "│"));
    expect(controller.sidebar.columns(100)).toBe(60);
  });
});

describe("riskLevel", () => {
  it("maps agent approval risks and ignores unknown or prototype keys", () => {
    expect(riskLevel("safe")).toBe("low");
    expect(riskLevel("review")).toBe("medium");
    expect(riskLevel("dangerous")).toBe("high");
    expect(riskLevel("constructor")).toBeUndefined();
    expect(riskLevel(undefined)).toBeUndefined();
  });
});

describe("/theme picker", () => {
  /** The full root (theme provider follows the controller), with themes from a temp dir and an in-memory store. */
  async function renderThemed(): Promise<{ setup: Setup; bridge: FakeBridge; controller: SessionController; saved: () => string | undefined }> {
    const bridge = new FakeBridge();
    const controller = new SessionController(bridge, undefined, new FakeCli(), undefined, undefined, undefined, async () => DISABLED_TASKS);
    const themes = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-app-themes-"));
    fs.writeFileSync(path.join(themes, "neon.json"), JSON.stringify({ name: "neon", extends: "slate", colors: { background: "#200020" } }));
    let saved: string | undefined;
    const store = { read: () => saved, write: (selector: string) => { saved = selector; } };
    controller.themes.configure({ theme: slateCrewCoderTheme, selector: "slate", source: "default" }, store, { themes, examples: EXAMPLE_THEMES_DIR });
    const setup = await testRender(<Root controller={controller} onQuit={() => {}} />, { width: 90, height: 34 });
    active = setup;
    await setup.renderOnce();
    return { setup, bridge, controller, saved: () => saved };
  }

  /** Waits until the top-left cell is drawn on `hex`: the whole UI follows the theme background. */
  async function waitForBackground(setup: Setup, hex: string): Promise<void> {
    const color = RGBA.fromHex(hex);
    await vi.waitFor(async () => {
      await setup.renderOnce();
      expect(setup.captureSpans().lines[0]?.spans[0]?.bg.equals(color)).toBe(true);
    });
  }

  async function openThemePicker(setup: Setup): Promise<void> {
    await setup.mockInput.typeText("/theme");
    setup.mockInput.pressEnter();
    await setup.waitForFrame((text) => text.includes("Enter apply") && text.includes("neon"));
  }

  it("lists built-ins, your themes, and examples from the palette", async () => {
    const { setup } = await renderThemed();
    await openThemePicker(setup);
    const frame = setup.captureCharFrame();
    for (const text of ["Built-in", "slate", "dark", "light", "Your themes", "neon", "Examples", "ember", "↑↓ preview · Enter apply · Esc keep current"]) {
      expect(frame).toContain(text);
    }
  });

  it("previews as the cursor moves and keeps the applied theme on Esc", async () => {
    const { setup, controller, saved } = await renderThemed();
    await openThemePicker(setup);
    setup.mockInput.pressArrow("down");
    await waitForBackground(setup, crewCoderTheme.background);
    setup.mockInput.pressEscape();
    await waitForBackground(setup, slateCrewCoderTheme.background);
    expect(controller.themes.selector).toBe("slate");
    expect(saved()).toBeUndefined();
  });

  it("applies and saves the pick with Enter, and recolors code already on screen", async () => {
    registerBundledGrammars();
    const { setup, bridge, controller, saved } = await renderThemed();
    await setup.mockInput.typeText("hi");
    setup.mockInput.pressEnter();
    bridge.emit({ type: "assistant_delta", text: "```python\ndef greet():\n    return 'hi'\n```\n" });
    bridge.emit({ type: "agent_end" });
    await setup.waitForFrame((text) => text.includes("def greet"));
    const keyword = async (hex: string): Promise<void> => vi.waitFor(async () => {
      await setup.renderOnce();
      const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
      expect(spans.some((span) => span.text.includes("def") && span.fg.equals(RGBA.fromHex(hex)))).toBe(true);
    }, { timeout: 8_000 });
    await keyword(slateCrewCoderTheme.syntax.keyword);
    await openThemePicker(setup);
    setup.mockInput.pressArrow("down");
    setup.mockInput.pressArrow("down");
    setup.mockInput.pressEnter();
    await waitForBackground(setup, lightCrewCoderTheme.background);
    await keyword(lightCrewCoderTheme.syntax.keyword);
    expect(controller.themes.selector).toBe("light");
    expect(saved()).toBe("light");
    expect(controller.picker).toBeUndefined();
    expect(setup.captureCharFrame()).toContain("Saved for next launch.");
  });

  it("applies a theme typed after /theme, and reports a broken one without changing", async () => {
    const { setup, controller, saved } = await renderThemed();
    await setup.mockInput.typeText("/theme neon");
    setup.mockInput.pressEnter();
    await waitForBackground(setup, "#200020");
    expect(saved()).toBe("neon");
    await setup.mockInput.typeText("/theme nope");
    setup.mockInput.pressEnter();
    await setup.waitForFrame((text) => text.includes("Theme not found: nope"));
    expect(controller.themes.selector).toBe("neon");
  });
});
