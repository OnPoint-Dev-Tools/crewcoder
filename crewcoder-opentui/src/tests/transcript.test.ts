import type { TuiEventBlock } from "@onpoint-dev-tools/crewcoder-tui-core/state/tui-store";
import { describe, expect, it } from "vitest";
import { blockToRow, isStreaming, normalize, transcriptSections } from "../transcript.js";

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

  it("flags failed tools as errors", () => {
    expect(blockToRow({ type: "tool", name: "bash", status: "error", text: "boom" })).toMatchObject({ tone: "error", text: "boom" });
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

describe("isStreaming", () => {
  it("streams only the last assistant or thinking block of an active run", () => {
    expect(isStreaming({ type: "assistant", text: "a" }, true, true)).toBe(true);
    expect(isStreaming({ type: "thinking", text: "a" }, true, true)).toBe(true);
    expect(isStreaming({ type: "assistant", text: "a" }, false, true)).toBe(false);
    expect(isStreaming({ type: "assistant", text: "a" }, true, false)).toBe(false);
    expect(isStreaming({ type: "tool", name: "bash", status: "running" }, true, true)).toBe(false);
  });
});

describe("transcriptSections", () => {
  it("groups consecutive tools and approvals into one work section, in event order", () => {
    const blocks: TuiEventBlock[] = [
      { type: "user", text: "go" },
      { type: "thinking", text: "plan" },
      { type: "tool", name: "read", status: "done" },
      { type: "approval", text: "rm", status: "approved" },
      { type: "tool", name: "bash", status: "running" },
      { type: "assistant", text: "done" },
      { type: "tool", name: "grep", status: "done" }
    ];
    const sections = transcriptSections(blocks);

    expect(sections.map((section) => section.kind)).toEqual(["block", "block", "work", "block", "work"]);
    expect(sections[2]).toMatchObject({ kind: "work", start: 2 });
    expect(sections[2]?.kind === "work" && sections[2].blocks).toEqual([blocks[2], blocks[3], blocks[4]]);
    expect(sections[4]).toMatchObject({ kind: "work", start: 6 });
  });
});

describe("normalize", () => {
  it("normalizes Windows line endings and strips terminal control sequences", () => {
    expect(normalize("a\r\nb\rc")).toBe("a\nb\nc");
    expect(normalize("\x1b[31mred\x1b[0m \x1b]0;title\x07ok\x07\x08")).toBe("red ok");
  });
});
