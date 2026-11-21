import { TextareaRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { describe, expect, it } from "vitest";
import { indexToOffset, offsetToIndex } from "../text-offset.js";

// Text, then the textarea's cursorOffset at its end (measured on OpenTUI 0.9.2).
const CASES: ReadonlyArray<readonly [string, number]> = [
  ["ab", 2], ["éx", 2], ["😀x", 3], ["👨‍👩‍👧x", 3], ["中x", 3], ["🇺🇸x", 3], ["a\nb", 3], ["a\tb", 4], ["​x", 1]
];

describe("textarea cursor offsets", () => {
  it("convert between display-cell offsets and JS indices", () => {
    for (const [text, end] of CASES) {
      expect(offsetToIndex(text, end), JSON.stringify(text)).toBe(text.length);
      expect(indexToOffset(text, text.length), JSON.stringify(text)).toBe(end);
    }
    // Before "x" in "😀x": index 2, offset 2.
    expect(offsetToIndex("😀x", 2)).toBe(2);
    expect(indexToOffset("😀x", 2)).toBe(2);
    expect(offsetToIndex("ab", 99)).toBe(2);
  });

  it("match OpenTUI's own textarea", async () => {
    const { renderer } = await createTestRenderer({ width: 40, height: 5 });
    const textarea = new TextareaRenderable(renderer, { width: 30, height: 4 });
    renderer.root.add(textarea);
    try {
      for (const [text] of CASES) {
        textarea.setText(text);
        textarea.gotoBufferEnd();
        expect(textarea.cursorOffset, JSON.stringify(text)).toBe(indexToOffset(text, text.length));
      }
    } finally {
      renderer.destroy();
    }
  });
});
