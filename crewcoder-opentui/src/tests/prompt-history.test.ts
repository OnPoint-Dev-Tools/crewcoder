import type { TuiEventBlock } from "@onpoint-dev-tools/crewcoder-tui-core/state/tui-store";
import { describe, expect, it } from "vitest";
import { IDLE_RECALL, sentMessages, stepRecall, type HistoryRecall } from "../prompt-history.js";

const user = (text: string): TuiEventBlock => ({ type: "user", text });

describe("sentMessages", () => {
  it("lists user messages newest first, trimmed, without blanks, other blocks, or back-to-back repeats", () => {
    const blocks: TuiEventBlock[] = [
      user(" first "), { type: "assistant", text: "reply" }, user(""), user("second"), user("second"), user("first")
    ];
    expect(sentMessages(blocks)).toEqual(["first", "second", "first"]);
  });
});

/** Run a sequence of key presses against an editable composer, like App does. */
function press(messages: string[], keys: Array<"up" | "down">, start = ""): string[] {
  let recall: HistoryRecall = IDLE_RECALL;
  let text = start;
  const shown: string[] = [];
  for (const key of keys) {
    const step = stepRecall(recall, key, text, messages);
    if (step) {
      recall = step.recall;
      text = step.text;
    }
    shown.push(text);
  }
  return shown;
}

describe("stepRecall", () => {
  const messages = ["newest", "middle", "oldest"];

  it("walks older with Up, stops at the oldest, and walks back to the draft with Down", () => {
    expect(press(messages, ["up", "up", "up", "up", "down", "down", "down", "down"], "draft"))
      .toEqual(["newest", "middle", "oldest", "oldest", "middle", "newest", "draft", "draft"]);
  });

  it("does nothing without history, or on Down when not recalling", () => {
    expect(stepRecall(IDLE_RECALL, "up", "x", [])).toBeUndefined();
    expect(stepRecall(IDLE_RECALL, "down", "x", messages)).toBeUndefined();
  });

  it("starts over from the newest message once a recalled message is edited", () => {
    const first = stepRecall(IDLE_RECALL, "up", "", messages)!;
    const second = stepRecall(first.recall, "up", first.text, messages)!;
    expect(second.text).toBe("middle");
    // The user edits "middle"; the next Up recalls the newest again and saves the edit as the draft.
    const edited = stepRecall(second.recall, "up", "middle!", messages)!;
    expect(edited.text).toBe("newest");
    expect(stepRecall(edited.recall, "down", edited.text, messages)!.text).toBe("middle!");
    // Down after an edit has nothing to restore.
    expect(stepRecall(second.recall, "down", "middle!", messages)).toBeUndefined();
  });
});
