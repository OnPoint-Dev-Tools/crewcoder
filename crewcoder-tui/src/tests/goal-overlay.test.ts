import { describe, expect, it } from "vitest";
import { GoalOverlay, type GoalDraft } from "../components/GoalOverlay.js";
import type { KeyEvent } from "../tui/component.js";

function key(name: string, sequence = "", ctrl = false): KeyEvent {
  return { name, sequence, ctrl, meta: false, shift: false };
}

function type(component: GoalOverlay, value: string): void {
  for (const char of value) component.handleInput(key(char, char));
}

function erase(component: GoalOverlay, count: number): void {
  for (let index = 0; index < count; index++) component.handleInput(key("backspace"));
}

describe("GoalOverlay", () => {
  it("edits and submits per-goal maker-verifier settings", () => {
    let submitted: GoalDraft | undefined;
    const overlay = new GoalOverlay(
      { maxTurns: 200, checkModel: "o4-mini", timeoutMinutes: 480 },
      "codex",
      "maker",
      (draft) => { submitted = draft; }
    );

    type(overlay, "Ship after tests pass");
    overlay.handleInput(key("return"));
    erase(overlay, 3);
    type(overlay, "25");
    overlay.handleInput(key("return"));
    erase(overlay, 7);
    type(overlay, "checker-small");
    overlay.handleInput(key("return"));
    erase(overlay, 3);
    type(overlay, "90");
    overlay.handleInput(key("return"));

    expect(submitted).toEqual({
      objective: "Ship after tests pass",
      maxTurns: 25,
      checkModel: "checker-small",
      timeoutMinutes: 90
    });
  });

  it("does not submit invalid limits", () => {
    let submitted = false;
    const overlay = new GoalOverlay({ maxTurns: 200, timeoutMinutes: 480 }, "claude", "maker", () => { submitted = true; });
    type(overlay, "Finish safely");
    overlay.handleInput(key("return"));
    erase(overlay, 3);
    type(overlay, "0");
    overlay.handleInput(key("s", "", true));
    expect(submitted).toBe(false);
  });
});
