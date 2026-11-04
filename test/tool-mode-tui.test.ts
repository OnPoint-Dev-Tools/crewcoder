import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as bridge from "../crewcoder-tui/src/bridge/crewcoder-process.js";
import { App } from "../crewcoder-tui/src/components/App.js";
import { builtinPaletteItems } from "../crewcoder-tui/src/components/CommandPalette.js";
import { createInitialState } from "../crewcoder-tui/src/state/tui-store.js";
import { parseInputEvents } from "../crewcoder-tui/src/tui/input.js";
import { stripAnsi } from "../crewcoder-tui/src/tui/ansi.js";
import { crewCoderTheme } from "../crewcoder-tui/src/theme/theme.js";

beforeEach(() => {
  vi.spyOn(bridge, "execCrewCoderCommand").mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
  fs.mkdirSync(process.env.CREWCODER_HOME!, { recursive: true });
  fs.writeFileSync(path.join(process.env.CREWCODER_HOME!, "config.json"), '{"toolMode":"native"}');
});
afterEach(() => vi.restoreAllMocks());
const submit = (app: App, command: string) => { for (const event of parseInputEvents(command + "\r")) app.handleInput(event); };

it("offers Tool mode in Settings and renders its selected mode in the picker", async () => {
  expect(builtinPaletteItems()).toContainEqual(expect.objectContaining({category:"Settings",label:"/tool-mode"}));
  const app = new App(createInitialState());
  submit(app, "/tool-mode");
  await vi.waitFor(() => {
    const rendered = app.render({theme:crewCoderTheme,size:{width:120,height:35}}).map(stripAnsi).join("\n");
    expect(rendered).toContain("Tool mode for new sessions");
    expect(rendered).toContain("* Provider-native tools");
    expect(rendered).toContain("CrewCoder tools");
  });
});

it("persists a default while keeping the active session intact", async () => {
  const state = createInitialState();
  state.sessionId = "existing";
  const app = new App(state);
  submit(app, "/tool-mode native");
  await vi.waitFor(() => expect(state.blocks.at(-1)).toMatchObject({type:"system",text:expect.stringContaining("Use /new")}));
  expect(bridge.execCrewCoderCommand).toHaveBeenCalledWith(["config","set","toolMode","native"]);
  expect(state.sessionId).toBe("existing");
});

it("reports persistence failures without claiming success", async () => {
  vi.mocked(bridge.execCrewCoderCommand).mockRejectedValue(new Error("SSH disconnected"));
  const state = createInitialState();
  submit(new App(state), "/tool-mode native");
  await vi.waitFor(() => expect(state.blocks.at(-1)).toEqual({type:"error",text:"SSH disconnected"}));
  expect(state.running).toBe(false);
});

it("rejects unknown values and edits during a run", () => {
  const state = createInitialState();
  const app = new App(state);
  submit(app, "/tool-mode both");
  expect(state.blocks.at(-1)).toMatchObject({type:"error",text:expect.stringContaining("Usage:")});
  state.running = true;
  submit(app, "/tool-mode native");
  expect(state.blocks.at(-1)).toMatchObject({type:"error",text:expect.stringContaining("Wait for")});
  expect(bridge.execCrewCoderCommand).not.toHaveBeenCalled();
});
