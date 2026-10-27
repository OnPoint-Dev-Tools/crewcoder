import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as bridge from "../bridge/crewcoder-process.js";
import { App } from "../components/App.js";
import { Composer } from "../components/Composer.js";
import { builtinPaletteItems } from "../components/CommandPalette.js";
import { createInitialState } from "../state/tui-store.js";
import { parseInputEvents } from "../tui/input.js";
import { stripAnsi } from "../tui/ansi.js";
import { crewCoderTheme } from "../theme/theme.js";

beforeEach(() => {
  vi.spyOn(bridge, "execCrewCoderCommand").mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
});
afterEach(() => vi.restoreAllMocks());

function submit(app: App, text: string): void {
  for (const event of parseInputEvents(text + "\r")) app.handleInput(event);
}

describe("worker identity setting", () => {
  it("offers /identity in Settings", () => {
    expect(createInitialState().workerIdentityEnabled).toBe(false);
    expect(builtinPaletteItems()).toContainEqual(expect.objectContaining({ label: "/identity", category: "Settings" }));
  });

  it.each([true, false])("persists identity enabled=%s without changing the worker or custom prompt", async (enabled) => {
    const state = createInitialState();
    state.workerIdentityEnabled = !enabled;
    state.worker = "Reviewer";
    state.systemPrompt = "strict-review";
    const app = new App(state);
    submit(app, enabled ? "/identity on" : "/identity off");
    await vi.waitFor(() => expect(state.workerIdentityEnabled).toBe(enabled));
    expect(bridge.execCrewCoderCommand).toHaveBeenCalledWith(["config", "set", "workerIdentityEnabled", String(enabled)]);
    expect(state.worker).toBe("Reviewer");
    expect(state.systemPrompt).toBe("strict-review");
    const rendered = new Composer(state, () => {}).render({ theme: crewCoderTheme, size: { width: 180, height: 8 } }).map(stripAnsi).join("\n");
    expect(rendered).toContain(enabled ? "Reviewer »" : "General »");
    expect(rendered).toContain(enabled ? "MODE: worker:Reviewer" : "MODE: general");
    if (!enabled) expect(rendered).not.toContain("Reviewer");
  });

  it("shows status and rejects invalid values without invoking the backend", () => {
    const state = createInitialState();
    state.workerIdentityEnabled = false;
    const app = new App(state);
    submit(app, "/identity");
    expect(state.blocks.at(-1)).toEqual({ type: "system", text: "Worker identity is off." });
    submit(app, "/identity maybe");
    expect(state.blocks.at(-1)).toEqual({ type: "error", text: "Usage: /identity on|off|status" });
    expect(state.workerIdentityEnabled).toBe(false);
    expect(bridge.execCrewCoderCommand).not.toHaveBeenCalled();
  });

  it("keeps the previous identity state when persistence fails", async () => {
    vi.mocked(bridge.execCrewCoderCommand).mockResolvedValue({ stdout: "", stderr: "config write denied", exitCode: 1 });
    const state = createInitialState();
    state.workerIdentityEnabled = true;
    const app = new App(state);
    submit(app, "/identity off");
    await vi.waitFor(() => expect(state.blocks.at(-1)).toEqual({ type: "error", text: "config write denied" }));
    expect(state.workerIdentityEnabled).toBe(true);
  });

  it("reports backend transport failures without an unhandled rejection", async () => {
    vi.mocked(bridge.execCrewCoderCommand).mockRejectedValue(new Error("SSH disconnected"));
    const state = createInitialState();
    state.workerIdentityEnabled = true;
    const app = new App(state);
    submit(app, "/identity off");
    await vi.waitFor(() => expect(state.blocks.at(-1)).toMatchObject({ type: "error", text: expect.stringContaining("SSH disconnected") }));
    expect(state.workerIdentityEnabled).toBe(true);
  });
});
