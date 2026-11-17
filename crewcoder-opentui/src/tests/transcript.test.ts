import type { TuiEventBlock } from "@onpoint-dev-tools/crewcoder-tui-core/state/tui-store";
import { describe, expect, it } from "vitest";
import { blockPhase, blockToRow, normalize } from "../transcript.js";

describe("blockToRow", () => {
  it("keeps thinking separate from assistant text and background separate from typed text", () => {
    const rows = ([
      { type: "user", text: "hi", background: ["repo: crewcoder", "branch: main"] },
      { type: "thinking", text: "plan" },
      { type: "assistant", text: "hello" }
    ] satisfies TuiEventBlock[]).map(blockToRow);

    expect(rows.map((row) => [row.label, row.tone, row.text])).toEqual([
      ["YOU", "user", "hi"],
      ["THINKING", "thinking", "plan"],
      ["CREW CODER", "assistant", "hello"]
    ]);
    expect(rows[0]?.detail).toBe("repo: crewcoder\nbranch: main");
  });

  it("clamps long tool output and flags failed tools as errors", () => {
    const output = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n");
    const row = blockToRow({ type: "tool", name: "bash", status: "error", text: output });

    expect(row.tone).toBe("error");
    expect(row.text.split("\n")).toHaveLength(13);
    expect(row.text).toContain("… 8 more lines");
  });

  it("records an extension question and its answer without internal ids", () => {
    const row = blockToRow({ type: "extension_ui", requestId: "req-7", extensionId: "ext.internal", uiKind: "select", title: "Pick a cache", status: "answered", answer: "remote" });
    expect(row).toEqual({ label: "QUESTION · answered", tone: "approval", text: "Pick a cache", detail: "Answer: remote" });
    expect(JSON.stringify(row)).not.toContain("req-7");
    expect(JSON.stringify(row)).not.toContain("ext.internal");
    expect(blockToRow({ type: "extension_ui", requestId: "r", extensionId: "e", uiKind: "confirm", title: "Go?", status: "cancelled" }).detail).toBeUndefined();
  });

  it("shows unported structured blocks instead of dropping them", () => {
    expect(blockToRow({ type: "crew", workers: [], completed: false })).toMatchObject({ label: "CREW", tone: "muted" });
  });
});

describe("blockPhase", () => {
  it("streams only the last assistant or thinking block of an active run", () => {
    expect(blockPhase({ type: "assistant", text: "a" }, true, true)).toBe("streaming");
    expect(blockPhase({ type: "thinking", text: "a" }, true, true)).toBe("streaming");
    expect(blockPhase({ type: "assistant", text: "a" }, false, true)).toBe("final");
  });

  it("keeps in-place changing blocks live while the run is active", () => {
    expect(blockPhase({ type: "tool", name: "bash", status: "running" }, false, true)).toBe("live");
    expect(blockPhase({ type: "tool", name: "bash", status: "done" }, false, true)).toBe("final");
    expect(blockPhase({ type: "approval", text: "x", status: "pending" }, false, true)).toBe("live");
    expect(blockPhase({ type: "approval", text: "x", status: "denied" }, false, true)).toBe("final");
    expect(blockPhase({ type: "crew", workers: [], completed: false }, false, true)).toBe("live");
  });

  it("treats every block as final once the run is over, even one left running", () => {
    expect(blockPhase({ type: "tool", name: "bash", status: "running" }, true, false)).toBe("final");
    expect(blockPhase({ type: "assistant", text: "a" }, true, false)).toBe("final");
  });
});

describe("normalize", () => {
  it("normalizes Windows line endings and strips terminal control sequences", () => {
    expect(normalize("a\r\nb\rc")).toBe("a\nb\nc");
    expect(normalize("\x1b[31mred\x1b[0m \x1b]0;title\x07ok\x07\x08")).toBe("red ok");
  });
});
