import { describe, expect, it } from "vitest";
import { Composer } from "../components/Composer.js";
import { createInitialState } from "../state/tui-store.js";
import type { TuiState } from "../state/tui-store.js";
import type { KeyEvent } from "../tui/component.js";

function key(name: string, overrides: Partial<KeyEvent> = {}): KeyEvent {
  return { name, sequence: "", ctrl: false, meta: false, shift: false, ...overrides };
}

function type(composer: Composer, text: string): void {
  for (const char of text) composer.handleInput(key("", { sequence: char }));
}

function stateWithMessages(...texts: string[]): TuiState {
  const state = createInitialState();
  state.blocks = texts.map((text) => ({ type: "user", text }));
  return state;
}

describe("Composer session message recall", () => {
  it("shows the most recent sent message on each Arrow-up press", () => {
    const state = stateWithMessages("first message", "second message", "third message");
    const composer = new Composer(state, () => {});

    expect(composer.handleInput(key("up"))).toBe(true);
    expect(state.input).toBe("third message");
    expect(state.inputCursor).toBe("third message".length);

    composer.handleInput(key("up"));
    expect(state.input).toBe("second message");

    composer.handleInput(key("up"));
    expect(state.input).toBe("first message");
  });

  it("stops at the oldest message so the caller can scroll the viewport", () => {
    const state = stateWithMessages("only message");
    const composer = new Composer(state, () => {});

    expect(composer.handleInput(key("up"))).toBe(true);
    expect(state.input).toBe("only message");
    expect(composer.handleInput(key("up"))).toBe(false);
    expect(state.input).toBe("only message");
  });

  it("walks back to newer messages and restores the draft with Arrow-down", () => {
    const state = stateWithMessages("older", "newer");
    const composer = new Composer(state, () => {});
    type(composer, "draft in progress");

    composer.handleInput(key("up"));
    composer.handleInput(key("up"));
    expect(state.input).toBe("older");

    composer.handleInput(key("down"));
    expect(state.input).toBe("newer");

    composer.handleInput(key("down"));
    expect(state.input).toBe("draft in progress");
    expect(state.inputCursor).toBe("draft in progress".length);

    // Draft restored: another Down has nothing left to do.
    expect(composer.handleInput(key("down"))).toBe(false);
  });

  it("restarts from the newest message after the recalled text is edited", () => {
    const state = stateWithMessages("older", "newer");
    const composer = new Composer(state, () => {});

    composer.handleInput(key("up"));
    expect(state.input).toBe("newer");
    type(composer, "!");

    composer.handleInput(key("up"));
    expect(state.input).toBe("newer");
  });

  it("submits a recalled message and clears the composer", () => {
    const state = stateWithMessages("run the tests");
    const submitted: string[] = [];
    const composer = new Composer(state, (value) => submitted.push(value));

    composer.handleInput(key("up"));
    composer.handleInput(key("return"));

    expect(submitted).toEqual(["run the tests"]);
    expect(state.input).toBe("");
  });

  it("skips blank and repeated messages", () => {
    const state = stateWithMessages("alpha", "beta", "beta", "   ");
    const composer = new Composer(state, () => {});

    composer.handleInput(key("up"));
    expect(state.input).toBe("beta");
    composer.handleInput(key("up"));
    expect(state.input).toBe("alpha");
    expect(composer.handleInput(key("up"))).toBe(false);
  });

  it("moves within a multi-line draft before recalling", () => {
    const state = stateWithMessages("previous message");
    const composer = new Composer(state, () => {});

    type(composer, "one");
    composer.handleInput(key("return", { shift: true }));
    type(composer, "two");

    // Cursor is on line 2: Up moves to line 1 and leaves the draft alone.
    expect(composer.handleInput(key("up"))).toBe(true);
    expect(state.input).toBe("one\ntwo");

    // On line 1 there is nowhere left to move, so recall takes over.
    expect(composer.handleInput(key("up"))).toBe(true);
    expect(state.input).toBe("previous message");

    composer.handleInput(key("down"));
    expect(state.input).toBe("one\ntwo");
  });

  it("does nothing when the session has no sent messages", () => {
    const state = createInitialState();
    const composer = new Composer(state, () => {});

    expect(composer.handleInput(key("up"))).toBe(false);
    expect(composer.handleInput(key("down"))).toBe(false);
    expect(state.input).toBe("");
  });
});
