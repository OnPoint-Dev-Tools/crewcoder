import { testRender } from "@opentui/react/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App, riskLevel } from "../App.js";
import { applyFooterHeight, footerSettled, prepareFooterForWrites } from "../footer-sizer.js";
import { ThemeProvider } from "../providers/theme-provider.js";
import { attachScrollback, ScrollbackWriter } from "../scrollback-writer.js";
import { SessionController } from "../session-controller.js";
import { gothamTheme } from "../theme.js";
import { FakeBridge } from "./fake-bridge.js";

type Setup = Awaited<ReturnType<typeof testRender>>;
let active: Setup | undefined;

afterEach(async () => {
  await active?.dispose();
  active = undefined;
});

async function renderApp(): Promise<{ setup: Setup; bridge: FakeBridge; onQuit: ReturnType<typeof vi.fn>; scrollbackText: () => Promise<string> }> {
  const bridge = new FakeBridge();
  const controller = new SessionController(bridge);
  const onQuit = vi.fn();
  // The writer needs the renderer, which testRender creates; give it a late-bound host.
  let setup: Setup | undefined;
  const writer = new ScrollbackWriter({ createScrollbackSurface: (options) => setup!.renderer.createScrollbackSurface(options) }, gothamTheme);
  setup = await testRender(
    <ThemeProvider theme={gothamTheme}>
      <App controller={controller} scrollback={writer} onQuit={onQuit} />
    </ThemeProvider>,
    { width: 80, height: 24, screenMode: "split-footer", externalOutputMode: "capture-stdout", footerHeight: 4 }
  );
  attachScrollback(controller, writer, { prepare: () => prepareFooterForWrites(setup!.renderer, controller.state), size: () => applyFooterHeight(setup!.renderer, controller.state, writer), settled: () => footerSettled(setup!.renderer) });
  active = setup;
  await setup.renderOnce();
  const scrollbackText = async (): Promise<string> => {
    await setup!.renderOnce();
    return setup!.externalOutput.takeText();
  };
  return { setup, bridge, onQuit, scrollbackText };
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
    expect(committed).toContain("THINKING");
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
    expect(frame).toContain("[^Y] Approve");
    expect(frame).toContain("[^N] Deny");

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

    const frame = await setup.waitForFrame((text) => text.includes("bash"));
    expect(frame).toContain("Working");
    expect(await scrollbackText()).not.toContain("TOOL bash");

    bridge.emit({ type: "tool_execution_end", toolName: "bash", toolCallId: "t1", result: "all green" });
    bridge.emit({ type: "agent_end" });
    expect(await scrollbackText()).toContain("TOOL bash");
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
    expect(frame).toContain("^C quit");

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
    const writer = new ScrollbackWriter({ createScrollbackSurface: (options) => setup!.renderer.createScrollbackSurface(options) }, gothamTheme);
    setup = await testRender(
      <ThemeProvider theme={gothamTheme}>
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

describe("riskLevel", () => {
  it("maps agent approval risks and ignores unknown or prototype keys", () => {
    expect(riskLevel("safe")).toBe("low");
    expect(riskLevel("review")).toBe("medium");
    expect(riskLevel("dangerous")).toBe("high");
    expect(riskLevel("constructor")).toBeUndefined();
    expect(riskLevel(undefined)).toBeUndefined();
  });
});
