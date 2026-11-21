import type { TuiEventBlock } from "@onpoint-dev-tools/crewcoder-tui-core/state/tui-store";
import stringWidth from "string-width";
import { describe, expect, it } from "vitest";
import {
  caseSensitive, findMatches, matchCounter, matchSnippet, MAX_SEARCH_MATCHES, occurrences, revealNeeded, searchableParts
} from "../transcript-search.js";

const numbered = (count: number, word = "line"): string => Array.from({ length: count }, (_, index) => `${word} ${index}`).join("\n");

describe("smart case", () => {
  it("ignores case unless the query has a capital letter", () => {
    expect(caseSensitive("needle")).toBe(false);
    expect(caseSensitive("Needle")).toBe(true);
    expect(occurrences("Needle needle NEEDLE", "needle")).toEqual([[0, 6], [7, 13], [14, 20]]);
    expect(occurrences("Needle needle NEEDLE", "Needle")).toEqual([[0, 6]]);
  });

  it("finds non-overlapping occurrences and nothing for an empty query", () => {
    expect(occurrences("aaaa", "aa")).toEqual([[0, 2], [2, 4]]);
    expect(occurrences("anything", "")).toEqual([]);
  });
});

describe("searchableParts", () => {
  it("searches what blocks draw, never their labels", () => {
    const blocks: TuiEventBlock[] = [
      { type: "assistant", text: "a reply" },
      { type: "thinking", text: "a thought" },
      { type: "user", text: "typed", background: ["repo context"] }
    ];
    expect(findMatches(blocks, "crew coder", "/w")).toEqual([]);
    expect(findMatches(blocks, "thinking", "/w")).toEqual([]);
    // Background context is drawn (muted), so it is searchable.
    expect(findMatches(blocks, "repo context", "/w")).toEqual([expect.objectContaining({ block: 2, kind: "text" })]);
  });

  it("includes all of a tool's output, past the collapse, as output lines", () => {
    const tool: TuiEventBlock = { type: "tool", id: "t1", name: "bash", status: "done", args: { command: "ls" }, text: numbered(30) };
    const [match] = findMatches([tool], "line 25", "/w");
    expect(match).toMatchObject({ block: 0, kind: "output", line: 25, text: "line 25" });
    expect(revealNeeded(match!)).toEqual({ expand: true, showDiff: false });
    const [early] = findMatches([tool], "line 3", "/w");
    expect(revealNeeded(early!)).toEqual({ expand: false, showDiff: false });
  });

  it("searches an edit's diff lines without their +/- sign when the view draws signs in the gutter", () => {
    const edit: TuiEventBlock = {
      type: "tool", id: "e1", name: "write", status: "done", args: { path: "a.ts", content: "const needle = 1;\n" }, text: "wrote a.ts"
    };
    const parts = searchableParts(edit, "/w");
    expect(parts.map((part) => part.kind)).toContain("diff");
    const [match] = findMatches([edit], "needle", "/w");
    expect(match).toMatchObject({ kind: "diff" });
    expect(revealNeeded(match!).showDiff).toBe(true);
    // The tool's own output is replaced by the diff, as in the view.
    expect(findMatches([edit], "wrote", "/w")).toEqual([]);
  });

  it("searches approvals and status panels as drawn", () => {
    const blocks: TuiEventBlock[] = [
      { type: "approval", id: "a1", toolName: "bash", text: "run rm", status: "denied", resolutionReason: "too risky" },
      { type: "background_job", bgId: "b1", command: "npm test", status: "running", output: "suite passed" }
    ];
    expect(findMatches(blocks, "too risky", "/w")).toEqual([expect.objectContaining({ block: 0 })]);
    expect(findMatches(blocks, "approval · bash · denied", "/w")).toHaveLength(1);
    expect(findMatches(blocks, "suite passed", "/w")).toEqual([expect.objectContaining({ block: 1 })]);
  });
});

describe("findMatches", () => {
  it("lists matches oldest first with their order inside each block", () => {
    const blocks: TuiEventBlock[] = [
      { type: "user", text: "needle one" },
      { type: "assistant", text: "needle two\nand needle three" }
    ];
    const matches = findMatches(blocks, "needle", "/w");
    expect(matches.map((match) => [match.block, match.ordinal, match.line, match.start])).toEqual([[0, 0, 0, 0], [1, 0, 0, 0], [1, 1, 1, 4]]);
    expect(matches[2]?.text).toBe("and needle three");
  });

  it("stops at the cap and says so in the counter", () => {
    const block: TuiEventBlock = { type: "assistant", text: "x ".repeat(MAX_SEARCH_MATCHES + 50) };
    expect(findMatches([block], "x", "/w")).toHaveLength(MAX_SEARCH_MATCHES);
    expect(matchCounter(4, MAX_SEARCH_MATCHES)).toBe(`5/${MAX_SEARCH_MATCHES}+`);
    expect(matchCounter(2, 12)).toBe("3/12");
    expect(matchCounter(undefined, 0)).toBe("0/0");
  });

  it("strips terminal controls before matching", () => {
    const block: TuiEventBlock = { type: "assistant", text: "red \x1b[31mneedle\x1b[0m" };
    expect(findMatches([block], "red needle", "/w")).toHaveLength(1);
  });
});

describe("matchSnippet", () => {
  it("keeps the match whole and some context on both sides, within the width", () => {
    const text = `${"before ".repeat(20)}NEEDLE${" after".repeat(20)}`;
    const start = text.indexOf("NEEDLE");
    for (const width of [10, 30, 60]) {
      const snippet = matchSnippet({ text, start, end: start + 6 }, width);
      expect(snippet.match).toBe("NEEDLE");
      expect(stringWidth(snippet.before + snippet.match + snippet.after)).toBeLessThanOrEqual(width);
    }
    const wide = matchSnippet({ text, start, end: start + 6 }, 60);
    expect(wide.before.startsWith("…")).toBe(true);
    expect(wide.after.endsWith("…")).toBe(true);
  });

  it("measures wide characters in cells", () => {
    const text = `${"漢字".repeat(30)}needle${"漢字".repeat(30)}`;
    const start = text.indexOf("needle");
    const snippet = matchSnippet({ text, start, end: start + 6 }, 21);
    expect(stringWidth(snippet.before + snippet.match + snippet.after)).toBeLessThanOrEqual(21);
  });

  it("shows a line that fits as is, even with the match far right", () => {
    expect(matchSnippet({ text: "  a needle b  ", start: 4, end: 10 }, 40)).toEqual({ before: "a ", match: "needle", after: " b" });
    const text = "Early reply that mentions the needle once.";
    const start = text.indexOf("needle");
    expect(matchSnippet({ text, start, end: start + 6 }, text.length)).toEqual({ before: "Early reply that mentions the ", match: "needle", after: " once." });
  });
});
