import { createInitialState, type TuiEventBlock } from "@onpoint-dev-tools/crewcoder-tui-core/state/tui-store";
import { describe, expect, it } from "vitest";
import { TranscriptSearch, type SearchHost } from "../search-controller.js";
import type { ToolBlock, ToolExpansion } from "../transcript.js";

function setup(blocks: TuiEventBlock[]) {
  const state = createInitialState();
  state.blocks = blocks;
  const expanded = new Set<ToolBlock>();
  const diffsHidden = new Set<ToolBlock>();
  let changes = 0;
  const toolExpansion: ToolExpansion = {
    isExpanded: (block) => expanded.has(block),
    toggle: (block) => void (expanded.has(block) ? expanded.delete(block) : expanded.add(block)),
    isDiffShown: (block) => !diffsHidden.has(block),
    toggleDiff: (block) => void (diffsHidden.has(block) ? diffsHidden.delete(block) : diffsHidden.add(block)),
    lineAnchors: () => undefined
  };
  const host: SearchHost = { state, toolExpansion, changed: () => void (changes += 1) };
  return { search: new TranscriptSearch(host), state, expanded, diffsHidden, changes: () => changes };
}

const replies = (...texts: string[]): TuiEventBlock[] => texts.map((text) => ({ type: "assistant", text }));

describe("TranscriptSearch", () => {
  it("starts at the newest match; older and newer walk and wrap", () => {
    const { search } = setup(replies("needle a", "nothing", "needle b", "needle c"));
    search.open("needle");
    expect(search.isOpen).toBe(true);
    expect(search.current?.block).toBe(3);
    search.older();
    expect(search.current?.block).toBe(2);
    search.older();
    expect(search.current?.block).toBe(0);
    search.older();
    expect(search.current?.block).toBe(3);
    search.newer();
    expect(search.current?.block).toBe(0);
  });

  it("bumps jumpVersion on every move, even to the same match", () => {
    const { search, changes } = setup(replies("needle"));
    search.open("needle");
    const version = search.jumpVersion;
    search.older();
    expect(search.current?.block).toBe(0);
    expect(search.jumpVersion).toBe(version + 1);
    expect(changes()).toBeGreaterThan(0);
  });

  it("has no current match for a query that finds nothing", () => {
    const { search } = setup(replies("hay"));
    search.open("needle");
    expect(search.current).toBeUndefined();
    expect(search.matches).toEqual([]);
    search.older();
    expect(search.current).toBeUndefined();
  });

  it("searches again when stepping, keeping its place as the transcript grows", () => {
    const { search, state } = setup(replies("needle a", "needle b"));
    search.open("needle");
    search.older();
    expect(search.current?.block).toBe(0);
    state.blocks.push({ type: "assistant", text: "needle c" });
    search.newer();
    expect(search.current?.block).toBe(1);
    expect(search.matches).toHaveLength(3);
  });

  it("expands collapsed output and shows a hidden diff so the match can be drawn", () => {
    const long: ToolBlock = { type: "tool", id: "t1", name: "bash", status: "done", args: { command: "ls" }, text: Array.from({ length: 30 }, (_, index) => `row ${index}`).join("\n") };
    const edit: ToolBlock = { type: "tool", id: "e1", name: "write", status: "done", args: { path: "a.ts", content: "const pin = 1;\n" }, text: "" };
    const { search, expanded, diffsHidden } = setup([long, edit]);
    diffsHidden.add(edit);

    search.open("row 3");
    // Line 3 shows while collapsed: nothing to expand.
    expect(expanded.has(long)).toBe(false);
    search.setQuery("row 28");
    expect(expanded.has(long)).toBe(true);

    search.setQuery("pin");
    expect(diffsHidden.has(edit)).toBe(false);
  });

  it("close clears the query and matches", () => {
    const { search } = setup(replies("needle"));
    search.open("needle");
    search.close();
    expect(search.isOpen).toBe(false);
    expect(search.query).toBe("");
    expect(search.current).toBeUndefined();
  });
});
