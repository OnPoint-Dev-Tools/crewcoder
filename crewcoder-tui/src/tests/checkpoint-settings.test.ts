import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../components/App.js";
import { commandOptions } from "../components/CommandPalette.js";
import { applyCrewCoderEvent } from "../state/event-reducer.js";
import { createInitialState } from "../state/tui-store.js";
import { parseInputEvents } from "../tui/input.js";

const originalCrewCoderBin = process.env.CREWCODER_BIN;

afterEach(() => {
  if (originalCrewCoderBin === undefined) delete process.env.CREWCODER_BIN;
  else process.env.CREWCODER_BIN = originalCrewCoderBin;
});

async function waitFor(condition: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

describe("TUI checkpoint settings", () => {
  it("offers /checkpoints in Settings", () => {
    const option = commandOptions.find((item) => item.command === "/checkpoints");
    expect(option?.description).toContain("on|off|status");
  });

  it("tracks checkpoint events without adding transcript blocks", () => {
    const state = createInitialState();
    const initialBlocks = [...state.blocks];

    applyCrewCoderEvent(state, {
      type: "checkpoint_created",
      checkpointId: "checkpoint_1",
      sessionId: "session_1",
      reason: "Before write",
      toolCallId: "call_1",
      toolName: "write",
      fileCount: 3,
      totalBytes: 120,
      truncated: false
    });

    expect(state.checkpoints).toHaveLength(1);
    expect(state.checkpoints[0]?.id).toBe("checkpoint_1");
    expect(state.blocks).toEqual(initialBlocks);
  });

  it("routes /checkpoints off to persistent backend config", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-checkpoint-command-"));
    const argsFile = path.join(dir, "args.txt");
    const bin = path.join(dir, "crewcoder");
    fs.writeFileSync(bin, `#!/usr/bin/env bash\nprintf '%s' "$*" > ${JSON.stringify(argsFile)}\nprintf '%s\\n' '{"checkpointsEnabled":false}'\n`, "utf8");
    fs.chmodSync(bin, 0o755);
    process.env.CREWCODER_BIN = bin;
    const state = createInitialState();
    const app = new App(state);

    for (const event of parseInputEvents("/checkpoints off\r")) app.handleInput(event);
    await waitFor(() => fs.existsSync(argsFile) && state.running === false, "checkpoint config command");

    expect(fs.readFileSync(argsFile, "utf8")).toBe("config set checkpointsEnabled false");
    expect(state.blocks.at(-1)).toMatchObject({ type: "system", text: expect.stringContaining("turned off") });
  });
});
