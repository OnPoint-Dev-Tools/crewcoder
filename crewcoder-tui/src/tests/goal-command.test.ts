import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { App, parseGoalStartInput, tokenizeGoalCommand } from "../components/App.js";
import { GoalOverlay } from "../components/GoalOverlay.js";
import { createInitialState } from "../state/tui-store.js";

const originalBin = process.env.CREWCODER_BIN;

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for goal command.");
}

afterEach(() => {
  if (originalBin === undefined) delete process.env.CREWCODER_BIN;
  else process.env.CREWCODER_BIN = originalBin;
});

describe("TUI /goal", () => {
  it("opens the preflight editor for a bare command", async () => {
    const state = createInitialState();
    const app = new App(state);
    (app as unknown as { submit(value: string): void }).submit("/goal");
    const readPopover = () => (app as unknown as { activePopover?: { component: unknown } }).activePopover;
    await waitFor(() => readPopover()?.component instanceof GoalOverlay);
    expect(readPopover()?.component).toBeInstanceOf(GoalOverlay);
  });

  it("starts a detached goal through the backend JSON contract", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-tui-goal-"));
    const bin = path.join(dir, "fake-crewcoder");
    fs.writeFileSync(bin, `#!/usr/bin/env node
const args = process.argv.slice(2);
const option = (name) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
console.log(JSON.stringify({ id: "goal_test", objective: args[2] || "objective", status: "queued", provider: "codex", model: "gpt-test", cycle: 0, maxTurns: Number(option("--max-turns")) || undefined, checkModel: option("--check-model"), timeoutMinutes: Number(option("--timeout-minutes")) || undefined }));
`, "utf8");
    fs.chmodSync(bin, 0o755);
    process.env.CREWCODER_BIN = bin;

    const state = createInitialState();
    state.model = "gpt-test";
    const app = new App(state);
    (app as unknown as { submit(value: string): void }).submit('/goal --max-turns 42 --check-model checker-small --timeout-minutes=75 "Ship the migration after tests pass"');
    await waitFor(() => !state.running && state.blocks.some((block) => block.type === "goal"));

    const goal = state.blocks.find((block) => block.type === "goal");
    expect(goal?.type === "goal" ? goal.goal : undefined).toMatchObject({
      id: "goal_test",
      objective: "Ship the migration after tests pass",
      status: "queued",
      provider: "codex",
      maxTurns: 42,
      checkModel: "checker-small",
      timeoutMinutes: 75
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("parses quoted objectives and validates inline overrides", () => {
    const parts = tokenizeGoalCommand('--max-turns=12 --no-check-model --timeout-minutes 30 "finish the migration safely"');
    expect(parseGoalStartInput(parts)).toEqual({
      objective: "finish the migration safely",
      maxTurns: 12,
      disableCheckModel: true,
      timeoutMinutes: 30
    });
    expect(() => parseGoalStartInput(tokenizeGoalCommand("--max-turns 0 invalid"))).toThrow(/1 to 10000/);
    expect(() => tokenizeGoalCommand('"unfinished')).toThrow(/Unclosed quote/);
  });
});
