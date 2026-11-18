import { testRender } from "@opentui/react/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App, riskLevel } from "../App.js";
import { footerModel } from "../footer-layout.js";
import { applyFooterHeight, footerSettled, prepareFooterForWrites } from "../footer-sizer.js";
import { ThemeProvider } from "../providers/theme-provider.js";
import { attachScrollback, ScrollbackWriter } from "../scrollback-writer.js";
import { SessionController } from "../session-controller.js";
import { slateTheme } from "../theme.js";
import { FakeBridge } from "./fake-bridge.js";
import { FakeCli, flush } from "./fake-cli.js";

type Setup = Awaited<ReturnType<typeof testRender>>;
let active: Setup | undefined;

afterEach(async () => {
  await active?.dispose();
  active = undefined;
});

async function renderApp(cli = new FakeCli(), options: { kittyKeyboard?: boolean } = {}): Promise<{ setup: Setup; bridge: FakeBridge; controller: SessionController; onQuit: ReturnType<typeof vi.fn>; scrollbackText: () => Promise<string> }> {
  const bridge = new FakeBridge();
  const controller = new SessionController(bridge, undefined, cli);
  const onQuit = vi.fn();
  // The writer needs the renderer, which testRender creates; give it a late-bound host.
  let setup: Setup | undefined;
  const writer = new ScrollbackWriter({ createScrollbackSurface: (options) => setup!.renderer.createScrollbackSurface(options) }, slateTheme);
  setup = await testRender(
    <ThemeProvider theme={slateTheme}>
      <App controller={controller} scrollback={writer} onQuit={onQuit} />
    </ThemeProvider>,
    { width: 80, height: 24, screenMode: "split-footer", externalOutputMode: "capture-stdout", footerHeight: 4, ...options }
  );
  // Mirrors cli.tsx, including picker rows, so palette sizing is exercised end to end.
  const footerState = () => ({ ...controller.state, extras: controller.footerExtras(setup!.renderer.terminalHeight, setup!.renderer.terminalWidth) });
  attachScrollback(controller, writer, { prepare: () => prepareFooterForWrites(setup!.renderer, footerState()), size: () => applyFooterHeight(setup!.renderer, footerState(), writer), settled: () => footerSettled(setup!.renderer) });
  active = setup;
  await setup.renderOnce();
  const scrollbackText = async (): Promise<string> => {
    await setup!.renderOnce();
    return setup!.externalOutput.takeText();
  };
  return { setup, bridge, controller, onQuit, scrollbackText };
}

describe("OpenTUI split-footer App", () => {
  it("writes the conversation to native scrollback and keeps only the live tail in the footer", async () => {
    const { setup, bridge, scrollbackText } = await renderApp();

    await setup.mockInput.typeText("hello crew");
    setup.mockInput.pressEnter();
    expect(bridge.runs).toEqual([expect.objectContaining({ prompt: "hello crew" })]);

    bridge.emit({ type: "agent_start", sessionId: "s-9" });
    bridge.emit({ type: "thinking_delta", text: "considering" });
    bridge.emit({ type: "assistant_delta", text: "hi there" });
    const footer = await setup.waitForFrame((text) => text.includes("Working"));
    expect(footer).toContain("hi there");
    expect(footer).toContain("s-9");

    bridge.emit({ type: "agent_end" });
    const committed = await scrollbackText();
    expect(committed).toContain("YOU");
    expect(committed).toContain("hello crew");
    expect(committed).toContain("💭 Reasoning");
    expect(committed).toContain("considering");
    expect(committed).toContain("CREW CODER");
    expect(committed).toContain("hi there");
    const idle = await setup.waitForFrame((text) => !text.includes("Working"));
    expect(idle).not.toContain("hi there");
  });

  it("shows a pending approval card and resolves it only with the configured chord", async () => {
    const { setup, bridge } = await renderApp();
    await setup.mockInput.typeText("clean");
    setup.mockInput.pressEnter();
    bridge.emit({ type: "approval_required", approvalId: "a-1", toolName: "bash", risk: "dangerous", reason: "rm -r build", args: { command: "rm -r build" } });

    const frame = await setup.waitForFrame((text) => text.includes("Tool Approval Required"));
    expect(frame).toContain("[HIGH RISK]");
    expect(frame).toContain("bash");
    expect(frame).toContain("Approve");
    expect(frame).toContain("Deny");
    expect(frame).not.toContain("^Y");
    expect(frame).not.toContain("^N");

    // Upstream termcn approved on a bare "y"; typing it in the composer must not approve.
    await setup.mockInput.typeText("yes y");
    await setup.renderOnce();
    expect(bridge.approvals).toEqual([]);

    setup.mockInput.pressKey("y", { ctrl: true });
    await setup.renderOnce();
    expect(bridge.approvals).toEqual([{ id: "a-1", approved: true }]);
  });

  it("shows running tools in the footer and commits them once they finish", async () => {
    const { setup, bridge, scrollbackText } = await renderApp();
    await setup.mockInput.typeText("test");
    setup.mockInput.pressEnter();
    bridge.emit({ type: "tool_execution_start", toolName: "bash", toolCallId: "t1", args: { command: "npm test" } });

    const frame = await setup.waitForFrame((text) => text.includes("💻 Run Command · npm test"));
    expect(frame).toContain("Working");
    expect(await scrollbackText()).not.toContain("Run Command");

    bridge.emit({ type: "tool_execution_end", toolName: "bash", toolCallId: "t1", result: "all green" });
    bridge.emit({ type: "agent_end" });
    expect(await scrollbackText()).toContain("💻 Run Command");
  });

  it("aborts the running request on escape and quits on ctrl+c", async () => {
    const { setup, bridge, onQuit } = await renderApp();
    await setup.mockInput.typeText("long");
    setup.mockInput.pressEnter();
    await setup.renderOnce();

    setup.mockInput.pressEscape();
    // A lone ESC is delivered after the parser's escape-sequence timeout.
    await vi.waitFor(() => expect(bridge.stops).toBe(1), { timeout: 2_000 });

    setup.mockInput.pressKey("c", { ctrl: true });
    expect(onQuit).toHaveBeenCalledTimes(1);
  });
});

describe("welcome screen", () => {
  it("centers the logo with the composer on a fresh session and leaves on the first prompt", async () => {
    const { setup, bridge } = await renderApp();
    const frame = await setup.waitForFrame((text) => text.includes("Type your first request"));
    const lines = frame.split("\n");
    const logoRow = lines.findIndex((line) => line.includes("██████"));

    expect(logoRow).toBeGreaterThan(0);
    // Centered horizontally: equal margins within one column.
    const logoLine = lines[logoRow] ?? "";
    const left = logoLine.length - logoLine.trimStart().length;
    const right = logoLine.length - logoLine.trimEnd().length;
    expect(Math.abs(left - right)).toBeLessThanOrEqual(1);
    // Centered vertically: blank rows above the logo.
    expect(lines.slice(0, logoRow).every((line) => line.trim() === "")).toBe(true);
    expect(frame).toContain("Ask CrewCoder");
    expect(frame).not.toContain("quit");

    await setup.mockInput.typeText("hello");
    setup.mockInput.pressEnter();
    expect(bridge.runs).toHaveLength(1);
    const after = await setup.waitForFrame((text) => text.includes("Working"));
    expect(after).not.toContain("██████");
  });

  it("shows only the composer, no logo, on a small window", async () => {
    const bridge = new FakeBridge();
    const controller = new SessionController(bridge);
    let setup: Setup | undefined;
    const writer = new ScrollbackWriter({ createScrollbackSurface: (options) => setup!.renderer.createScrollbackSurface(options) }, slateTheme);
    setup = await testRender(
      <ThemeProvider theme={slateTheme}>
        <App controller={controller} scrollback={writer} onQuit={() => {}} />
      </ThemeProvider>,
      { width: 60, height: 24, screenMode: "split-footer", externalOutputMode: "capture-stdout", footerHeight: 4 }
    );
    attachScrollback(controller, writer, { prepare: () => prepareFooterForWrites(setup!.renderer, controller.state), size: () => applyFooterHeight(setup!.renderer, controller.state, writer), settled: () => footerSettled(setup!.renderer) });
    active = setup;
    const frame = await setup.waitForFrame((text) => text.includes("Type your first request"));

    expect(frame).not.toContain("█");
    expect(frame).not.toContain("┏┓");
    expect(frame).not.toContain("CREW CODER");
    expect(frame).toContain("Ask CrewCoder");
  });

  it("keeps the composer at the bottom of the terminal during a short conversation", async () => {
    const { setup, bridge } = await renderApp();
    await setup.mockInput.typeText("hi");
    setup.mockInput.pressEnter();
    bridge.emit({ type: "agent_end" });
    // Require the composer: a frame captured mid-resize is unpainted and matches nothing.
    const frame = await setup.waitForFrame((text) => text.includes("Ask CrewCoder") && !text.includes("Type your first request") && !text.includes("Working"));
    const lines = frame.split("\n").filter((line, index, all) => index < all.length - 1 || line.trim() !== "");

    // The status line is the last row of the 24-row terminal, the composer just above it.
    expect(setup.renderer.footerHeight).toBeGreaterThan(4);
    expect(lines.at(-1)).toContain("claude");
    expect(lines.at(-3)).toContain("Ask CrewCoder");
  });

  it("returns to the welcome screen after /new", async () => {
    const { setup, bridge } = await renderApp();
    await setup.mockInput.typeText("hi");
    setup.mockInput.pressEnter();
    bridge.emit({ type: "agent_end" });
    await setup.waitForFrame((text) => !text.includes("Type your first request"));

    await setup.mockInput.typeText("/new");
    setup.mockInput.pressEnter();
    await setup.waitForFrame((text) => text.includes("Type your first request"));
  });
});

describe("pickers", () => {
  it("sizes the footer to the whole palette in a conversation", async () => {
    const { setup, bridge, controller } = await renderApp();
    await setup.mockInput.typeText("hi");
    setup.mockInput.pressEnter();
    bridge.emit({ type: "agent_end" });
    await setup.waitForFrame((text) => text.includes("Ask CrewCoder") && !text.includes("Type your first request"));

    await setup.mockInput.typeText("/");
    const frame = await setup.waitForFrame((text) => text.includes("Esc close") && text.includes("╰"));
    expect(setup.renderer.footerHeight).toBe(controller.footerExtras(setup.renderer.terminalHeight, setup.renderer.terminalWidth).overlayRows);
    expect(frame).toContain("/sessions");
    expect(frame).toMatch(/1\/\d+/);

    setup.mockInput.pressEscape();
    // A lone ESC is delivered after the parser's escape-sequence timeout.
    await vi.waitFor(() => expect(controller.picker).toBeUndefined(), { timeout: 2_000 });
    await setup.waitForFrame((text) => text.includes("Ask CrewCoder"));
    expect(bridge.stops).toBe(0);
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
  async function inConversation(options: { kittyKeyboard?: boolean } = {}) {
    const rendered = await renderApp(new FakeCli(), options);
    await rendered.setup.mockInput.typeText("hi");
    rendered.setup.mockInput.pressEnter();
    rendered.bridge.emit({ type: "agent_end" });
    await rendered.setup.waitForFrame((text) => text.includes("Ask CrewCoder") && !text.includes("Type your first request"));
    return rendered;
  }

  it("Shift+Enter adds a line, grows the footer, and Enter sends every line", async () => {
    const { setup, bridge, controller } = await inConversation({ kittyKeyboard: true });
    const before = setup.renderer.footerHeight;
    await setup.mockInput.typeText("first line");
    setup.mockInput.pressEnter({ shift: true });
    await setup.mockInput.typeText("second line");
    await vi.waitFor(() => expect(controller.composerLines).toBe(2));
    await setup.waitForFrame((text) => text.includes("second line"));
    expect(setup.renderer.footerHeight).toBe(before + 1);

    setup.mockInput.pressEnter();
    expect(bridge.runs.at(-1)).toMatchObject({ prompt: "first line\nsecond line" });
    await vi.waitFor(() => expect(setup.renderer.footerHeight).toBe(before));
  });

  it("Ctrl+J adds a line without the kitty keyboard protocol", async () => {
    const { setup, bridge } = await inConversation();
    await setup.mockInput.typeText("a");
    setup.mockInput.pressKey("j", { ctrl: true });
    await setup.mockInput.typeText("b");
    setup.mockInput.pressEnter();
    expect(bridge.runs.at(-1)).toMatchObject({ prompt: "a\nb" });
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
    const lines = frame.split("\n");
    expect(lines.findIndex((line) => line.includes("Provider thinking: on"))).toBeLessThan(lines.findIndex((line) => line.includes("CrewCoder") && line.includes("│")));
    expect(controller.footerExtras(24, 80).alertRows).toBe(3);
    expect(setup.renderer.footerHeight).toBe(footerModel([], false, controller.footerExtras(24, 80)).rows);

    await setup.mockInput.typeText("x");
    await setup.waitForFrame((text) => !text.includes("Provider thinking: on"));
    expect(controller.currentAlert).toBeUndefined();
  });
});

describe("compaction summary editor", () => {
  it("edits the summary in the footer and applies it with Ctrl+S", async () => {
    const { setup, bridge, controller } = await renderApp();
    await setup.mockInput.typeText("long task");
    setup.mockInput.pressEnter();
    bridge.emit({ type: "session_compaction_preview", previewId: "p-1", summary: "proposed summary" });
    await setup.waitForFrame((text) => text.includes("Edit compaction summary") && text.includes("proposed summary"));
    expect(setup.renderer.footerHeight).toBe(controller.footerExtras(24, 80).overlayRows);

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
    const rendered = await renderApp();
    await rendered.setup.mockInput.typeText("go");
    rendered.setup.mockInput.pressEnter();
    if (draft) await rendered.setup.mockInput.typeText(draft);
    rendered.bridge.emit({ type: "extension_ui_request", requestId: "q-1", extensionId: "ext.secret-id", ...event });
    return rendered;
  }

  it("answers a select with the original option value and commits the outcome", async () => {
    const { setup, bridge, controller, scrollbackText } = await asked({
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
    expect(setup.renderer.footerHeight).toBe(controller.footerExtras(24, 80).overlayRows);

    setup.mockInput.pressArrow("down");
    await setup.renderOnce();
    setup.mockInput.pressEnter();
    await setup.renderOnce();
    expect(bridge.uiResponses).toEqual([{ requestId: "q-1", value: "remote-s3" }]);
    expect(controller.question()).toBeUndefined();

    bridge.emit({ type: "extension_ui_resolved", requestId: "q-1" });
    bridge.emit({ type: "agent_end" });
    const committed = await scrollbackText();
    expect(committed).toContain("QUESTION · answered");
    expect(committed).toContain("Answer: remote-s3");
  });

  it("answers a confirm with y, and its keys never reach the composer", async () => {
    const { setup, bridge } = await asked({ uiKind: "confirm", title: "Overwrite the lockfile?" });
    await setup.waitForFrame((text) => text.includes("Overwrite the lockfile?") && text.includes("Yes"));
    setup.mockInput.pressKey("y");
    await setup.renderOnce();
    expect(bridge.uiResponses).toEqual([{ requestId: "q-1", value: true }]);
    const frame = await setup.waitForFrame((text) => !text.includes("Overwrite the lockfile?"));
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
    const frame = await setup.waitForFrame((text) => text.includes("half typed"));
    expect(frame).not.toContain("Name the release branch");
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
    const lines = frame.split("\n");
    const row = lines.findIndex((line) => line.includes("Bravo"));
    // Mouse rows are terminal rows; the split footer starts at the renderer's (private) render offset.
    const offset = (setup.renderer as unknown as { renderOffset: number }).renderOffset;
    await setup.mockMouse.click(lines[row]!.indexOf("Bravo"), offset + row);
    await setup.renderOnce();
    expect(bridge.uiResponses).toEqual([{ requestId: "q-1", value: "b" }]);
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
