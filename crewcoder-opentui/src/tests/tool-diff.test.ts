import { parsePatch } from "diff";
import { describe, expect, it } from "vitest";
import { computeLineAnchors } from "../diff-anchors.js";
import { anchorKey, findAnchor, snippetEdits, toolDiffs } from "../tool-diff.js";
import type { ToolBlock } from "../transcript.js";

const tool = (name: string, args: Record<string, unknown>, extra: Partial<ToolBlock> = {}): ToolBlock =>
  ({ type: "tool", name, status: "done", args, ...extra });

/** Every patch must parse as exactly one file, as OpenTUI's `<diff>` renders only the first. */
function expectSingleFilePatch(patch: string): void {
  const parsed = parsePatch(patch);
  expect(parsed).toHaveLength(1);
  expect(parsed[0]?.hunks.length).toBeGreaterThan(0);
}

describe("line anchors", () => {
  it("finds the 1-based line where the new text starts", () => {
    expect(findAnchor("a\nb\nc = 2\n", "c = 2")).toBe(3);
    expect(findAnchor("a\n", "missing")).toBeUndefined();
    expect(findAnchor("a\n", "")).toBeUndefined();
  });

  it("reads each edited file once, relative to the workspace, only for finished edits", async () => {
    const reads: string[] = [];
    const read = async (file: string) => {
      reads.push(file);
      return "one\ntwo\nthree = 3\nfour = 4\n";
    };
    const block = tool("edit_transaction", { edits: [{ path: "src/a.ts", find: "3", replace: "three = 3" }, { path: "src/a.ts", find: "4", replace: "four = 4" }, { path: "src/a.ts", find: "x", replace: "gone" }] });
    const anchors = await computeLineAnchors(block, "/repo", read);
    expect(reads).toEqual(["/repo/src/a.ts"]);
    expect([...(anchors?.values() ?? [])]).toEqual([3, 4]);
    expect(await computeLineAnchors({ ...block, status: "running" }, "/repo", read)).toBeUndefined();
    expect(await computeLineAnchors(block, "/repo", async () => undefined)).toBeUndefined();
  });
});

describe("toolDiffs", () => {
  it("builds a snippet diff from Claude Edit, with a workspace-relative path and no line numbers", () => {
    const [diff, ...rest] = toolDiffs(tool("Edit", { file_path: "/repo/src/a.ts", old_string: "const a = 1;\nconst b = 2;", new_string: "const a = 42;\nconst b = 2;" }), "/repo");
    expect(rest).toEqual([]);
    expect(diff).toMatchObject({ path: "src/a.ts", added: 1, removed: 1, body: ["-const a = 1;", "+const a = 42;", " const b = 2;"], exactLines: false });
    expect(diff?.patch).toContain("-const a = 1;\n+const a = 42;\n const b = 2;");
    expect(diff?.patch).not.toContain("No newline");
    expectSingleFilePatch(diff!.patch);
  });

  it("reads CrewCoder edit (find/replace) and edit_transaction across files", () => {
    expect(toolDiffs(tool("edit", { path: "a.ts", find: "x", replace: "y" }))).toMatchObject([{ path: "a.ts", added: 1, removed: 1 }]);
    const transaction = toolDiffs(tool("mcp__crewcoder__edit_transaction", { edits: [{ path: "a.ts", find: "1", replace: "2" }, { path: "b.ts", find: "3", replace: "4\n5" }] }));
    expect(transaction.map((diff) => [diff.path, diff.added, diff.removed])).toEqual([["a.ts", 1, 1], ["b.ts", 2, 1]]);
  });

  it("reads Claude MultiEdit edits against the shared file path", () => {
    const diffs = toolDiffs(tool("MultiEdit", { file_path: "a.ts", edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d" }] }));
    expect(diffs.map((diff) => diff.path)).toEqual(["a.ts", "a.ts"]);
  });

  it("shows a write as the whole new content, numbered from line 1", () => {
    const [diff] = toolDiffs(tool("Write", { file_path: "new.ts", content: "one\ntwo\n" }));
    expect(diff).toMatchObject({ path: "new.ts", added: 2, removed: 0, exactLines: true });
  });

  it("reads Codex file changes: real hunks for updates (headers added), content for adds, nothing for deletes", () => {
    const diffs = toolDiffs(tool("Codex file change", { changes: [
      { path: "/w/x.ts", kind: { type: "update" }, diff: "@@ -10,2 +10,2 @@\n-old\n+new\n ctx\n" },
      { path: "/w/y.ts", kind: { type: "add" }, diff: "fresh\n" },
      { path: "/w/z.ts", kind: { type: "delete" }, diff: "gone\nbye\n" }
    ] }), "/w");
    expect(diffs.map((diff) => [diff.path, diff.added, diff.removed, diff.exactLines, diff.status])).toEqual([
      ["x.ts", 1, 1, true, undefined],
      ["y.ts", 1, 0, true, "added"]
    ]);
    expect(diffs[0]?.patch).toContain("@@ -10,2 +10,2 @@");
    diffs.forEach((diff) => expectSingleFilePatch(diff.patch));
  });

  it("splits a unified diff in the output into one diff per file, leaving out deleted files", () => {
    const output = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/gone.ts b/gone.ts\n--- a/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\ndiff --git a/c.ts b/c.ts\n--- a/c.ts\n+++ b/c.ts\n@@ -1 +1 @@\n-c\n+d\n";
    expect(toolDiffs(tool("apply_patch", {}, { text: output })).map((diff) => diff.path)).toEqual(["a.ts", "c.ts"]);
  });

  it("returns nothing for failed edits, non-edit tools, and edits without old/new text", () => {
    expect(toolDiffs(tool("Edit", { file_path: "a.ts", old_string: "a", new_string: "b" }, { status: "error" }))).toEqual([]);
    expect(toolDiffs(tool("Read", { file_path: "a.ts", content: "x" }))).toEqual([]);
    expect(toolDiffs(tool("edit_symbol", { path: "a.ts", symbol: "f", body: "{}" }, { text: "Edited symbol f in a.ts" }))).toEqual([]);
  });

  it("numbers an anchored snippet edit with its real file lines", () => {
    const block = tool("edit", { path: "a.ts", find: "x = 1", replace: "x = 2" });
    const [edit] = snippetEdits(block);
    const [diff] = toolDiffs(block, undefined, new Map([[anchorKey(edit!), 40]]));
    expect(diff?.exactLines).toBe(true);
    expect(diff?.patch).toContain("@@ -40,1 +40,1 @@");
    expectSingleFilePatch(diff!.patch);
  });

  it("never shows diffs for shell commands, even if the tool block carries some", () => {
    const patch = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n";
    const fileDiffs = [{ path: "x", status: "modified" as const, additions: 1, deletions: 1, binary: false, truncated: false, patch }];
    expect(toolDiffs(tool("bash", { command: "sed -i s/a/b/ x" }, { fileDiffs }))).toEqual([]);
    expect(toolDiffs(tool("Codex command", { command: "sed -i s/a/b/ x" }, { fileDiffs }))).toEqual([]);
  });

  it("prefers the agent's snapshot diffs for edits, with notes for binary and oversized files", () => {
    const patch = "diff --git a/notes.txt b/notes.txt\n--- a/notes.txt\n+++ b/notes.txt\n@@ -3 +3 @@\n-old\n+new\n";
    const diffs = toolDiffs(tool("Edit", { file_path: "/repo/notes.txt", old_string: "old", new_string: "new" }, { fileDiffs: [
      { path: "/repo/notes.txt", status: "modified", additions: 1, deletions: 1, binary: false, truncated: false, patch },
      { path: "logo.png", status: "added", additions: 0, deletions: 0, binary: true, truncated: false },
      { path: "huge.json", status: "modified", additions: 9000, deletions: 0, binary: false, truncated: true }
    ] }), "/repo");
    expect(diffs.map((diff) => [diff.path, diff.added, diff.removed, diff.exactLines, diff.note])).toEqual([
      ["notes.txt", 1, 1, true, undefined],
      ["logo.png", 0, 0, true, "binary file"],
      ["huge.json", 9000, 0, true, "diff too large to show"]
    ]);
    expect(diffs[0]?.patch).toContain("@@ -3,1 +3,1 @@");
    expectSingleFilePatch(diffs[0]!.patch);
  });

  it("strips terminal controls from edit text", () => {
    const [diff] = toolDiffs(tool("edit", { path: "a.ts", find: "a", replace: "\u001b[31mred\u001b[0m" }));
    expect(diff?.patch).toContain("+red");
    expect(diff?.patch).not.toContain("\u001b");
  });
});
