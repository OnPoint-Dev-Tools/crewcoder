import { describe, expect, it } from "vitest";
import { CompactionPreviewOverlay, type CompactionPreviewResult } from "../components/CompactionPreviewOverlay.js";
import { crewCoderTheme } from "../theme/theme.js";
import { stripAnsi } from "../tui/ansi.js";
import type { KeyEvent } from "../tui/component.js";

function key(name: string, sequence = "", mods: Partial<Pick<KeyEvent, "ctrl" | "meta" | "shift">> = {}): KeyEvent {
  return { name, sequence, ctrl: false, meta: false, shift: false, ...mods };
}

function type(overlay: CompactionPreviewOverlay, text: string): void {
  for (const ch of text) overlay.handleInput(key(ch, ch));
}

const ctx = { theme: crewCoderTheme, size: { width: 60, height: 20 } };

describe("CompactionPreviewOverlay", () => {
  it("applies edits with ctrl+s and reports the final text", () => {
    let result: CompactionPreviewResult | undefined;
    const overlay = new CompactionPreviewOverlay({ title: "Edit", summary: "hello" }, (r) => { result = r; });
    type(overlay, " world");
    overlay.handleInput(key("s", "s", { ctrl: true }));
    expect(result).toEqual({ approved: true, summary: "hello world" });
  });

  it("supports backspace and newline editing", () => {
    let result: CompactionPreviewResult | undefined;
    const overlay = new CompactionPreviewOverlay({ title: "Edit", summary: "ab" }, (r) => { result = r; });
    overlay.handleInput(key("backspace", ""));
    overlay.handleInput(key("return", "\r"));
    type(overlay, "c");
    overlay.handleInput(key("s", "s", { ctrl: true }));
    expect(result?.summary).toBe("a\nc");
  });

  it("resets to the original summary with ctrl+r", () => {
    let result: CompactionPreviewResult | undefined;
    const overlay = new CompactionPreviewOverlay({ title: "Edit", summary: "original" }, (r) => { result = r; });
    type(overlay, " EDITED");
    overlay.handleInput(key("r", "r", { ctrl: true }));
    overlay.handleInput(key("s", "s", { ctrl: true }));
    expect(result?.summary).toBe("original");
  });

  it("moves the cursor and inserts mid-text", () => {
    let result: CompactionPreviewResult | undefined;
    const overlay = new CompactionPreviewOverlay({ title: "Edit", summary: "ac" }, (r) => { result = r; });
    overlay.handleInput(key("left", "")); // between a and c
    type(overlay, "b");
    overlay.handleInput(key("s", "s", { ctrl: true }));
    expect(result?.summary).toBe("abc");
  });

  it("renders the summary and key hints", () => {
    const overlay = new CompactionPreviewOverlay(
      { title: "Edit compaction summary", summary: "line one\nline two", source: "model", originalMessageCount: 20, retainedMessageCount: 8 },
      () => {}
    );
    const out = overlay.render(ctx).map(stripAnsi).join("\n");
    expect(out).toContain("Edit compaction summary");
    expect(out).toContain("model summary");
    expect(out).toContain("line one");
    expect(out).toContain("^S apply");
  });
});
