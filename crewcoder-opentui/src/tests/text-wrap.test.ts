import stringWidth from "string-width";
import { describe, expect, it } from "vitest";
import { wrapCells, wrapIndented } from "../text-wrap.js";

describe("wrapIndented", () => {
  it("keeps short lines, blank lines, and indentation as they are", () => {
    expect(wrapIndented("a\n\n    indented", 40)).toEqual(["a", "", "    indented"]);
  });

  it("hangs list continuations under the item text", () => {
    expect(wrapIndented("- one two three four", 10)).toEqual(["- one two", "  three", "  four"]);
    expect(wrapIndented("12. alpha beta gamma", 12)).toEqual(["12. alpha", "    beta", "    gamma"]);
  });

  it("breaks a long word (a path) and never exceeds the width, wide characters included", () => {
    for (const row of wrapIndented("  /a/very/long/path/without/spaces/漢字漢字", 12)) expect(stringWidth(row)).toBeLessThanOrEqual(12);
  });

  it("drops an indent that leaves no room instead of overflowing", () => {
    expect(wrapIndented("          deep", 6)).toEqual(["deep"]);
  });

  it("matches wrapCells for plain text", () => {
    expect(wrapIndented("one two three", 7)).toEqual(wrapCells("one two three", 7));
  });
});
