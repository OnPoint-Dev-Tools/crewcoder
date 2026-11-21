import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildFileDiffs, isFileEditTool, WorkspaceDiffTracker } from "../core/workspace-diffs.js";

function workspace(files: Record<string, string> = {}): { cwd: string; snapshots: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-diffs-"));
  const cwd = path.join(root, "ws");
  fs.mkdirSync(cwd);
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
    fs.writeFileSync(path.join(cwd, name), text);
  }
  return { cwd, snapshots: path.join(root, "snapshots") };
}

describe("WorkspaceDiffTracker", () => {
  it("diffs created and modified files only, skipping deletions and default excludes", async () => {
    const { cwd, snapshots } = workspace({ "keep.txt": "a\nb\n", "gone.txt": "x\n", "node_modules/m.js": "1" });
    const tracker = new WorkspaceDiffTracker(cwd, { snapshotsDir: snapshots });
    const baseline = await tracker.begin();
    fs.writeFileSync(path.join(cwd, "keep.txt"), "a\nB\n");
    fs.writeFileSync(path.join(cwd, "new.txt"), "hello\n");
    fs.unlinkSync(path.join(cwd, "gone.txt"));
    fs.writeFileSync(path.join(cwd, "node_modules/m.js"), "2");

    const files = await tracker.end(baseline);
    expect(files.map((file) => [file.path, file.status, file.additions, file.deletions])).toEqual([
      ["keep.txt", "modified", 1, 1],
      ["new.txt", "added", 1, 0]
    ]);
    expect(files[0]?.patch).toContain("-b\n+B");
    expect(await tracker.end(await tracker.begin())).toEqual([]);
  });

  it("never touches the workspace's own git repository", async () => {
    const { cwd, snapshots } = workspace({ "a.txt": "1\n" });
    execFileSync("git", ["init", "--quiet"], { cwd });
    const status = () => execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" });
    const before = status();
    const tracker = new WorkspaceDiffTracker(cwd, { snapshotsDir: snapshots });
    const baseline = await tracker.begin();
    fs.writeFileSync(path.join(cwd, "a.txt"), "2\n");
    await tracker.end(baseline);
    expect(status()).toBe(before);
    expect(execFileSync("git", ["ls-files"], { cwd, encoding: "utf8" })).toBe("");
  });

  it("credits a change to the first overlapping tool that finishes, never twice", async () => {
    const { cwd, snapshots } = workspace({ "a.txt": "1\n" });
    const tracker = new WorkspaceDiffTracker(cwd, { snapshotsDir: snapshots });
    const first = await tracker.begin();
    const second = await tracker.begin();
    fs.writeFileSync(path.join(cwd, "a.txt"), "2\n");
    expect((await tracker.end(first)).map((file) => file.path)).toEqual(["a.txt"]);
    expect(await tracker.end(second)).toEqual([]);
  });

  it("gives a provider-native tool the turn's primed baseline", async () => {
    const { cwd, snapshots } = workspace({ "a.txt": "1\n" });
    const tracker = new WorkspaceDiffTracker(cwd, { snapshotsDir: snapshots });
    await tracker.prime();
    // The provider tool already wrote before it was announced.
    fs.writeFileSync(path.join(cwd, "a.txt"), "2\n");
    const baseline = await tracker.begin({ reuseLast: true });
    expect((await tracker.end(baseline)).map((file) => file.path)).toEqual(["a.txt"]);
  });

  it("turns itself off for the home directory", async () => {
    const reasons: string[] = [];
    const tracker = new WorkspaceDiffTracker(os.homedir(), { onDisabled: (reason) => reasons.push(reason) });
    expect(await tracker.begin()).toBeUndefined();
    expect(reasons).toEqual(["workspace is the filesystem root or home directory"]);
  });
});

describe("buildFileDiffs", () => {
  it("marks binary files and leaves out their patch", () => {
    const files = buildFileDiffs("A\0img.png\0", "-\t-\timg.png\0", "diff --git a/img.png b/img.png\nBinary files differ\n");
    expect(files).toEqual([{ path: "img.png", status: "added", additions: 0, deletions: 0, binary: true, truncated: false }]);
  });

  it("drops patches over the size limit but keeps the counts", () => {
    const body = `+${"x".repeat(70_000)}\n`;
    const files = buildFileDiffs("M\0big.txt\0", "1\t0\tbig.txt\0", `diff --git a/big.txt b/big.txt\n--- a/big.txt\n+++ b/big.txt\n@@ -0,0 +1 @@\n${body}`);
    expect(files[0]).toMatchObject({ path: "big.txt", additions: 1, truncated: true });
    expect(files[0]?.patch).toBeUndefined();
  });
});

describe("isFileEditTool", () => {
  it("covers edit and write tools across providers, never shell commands or other mutations", () => {
    expect(["edit", "write", "Edit", "Write", "MultiEdit", "NotebookEdit", "Codex file change", "apply_patch", "mcp__crewcoder__edit_transaction", "edit_symbol"].every(isFileEditTool)).toBe(true);
    expect(["bash", "Bash", "Codex command", "shell", "delegateWorker", "Task", "git_commit", "createPlugin", "read", "grep"].some(isFileEditTool)).toBe(false);
  });
});
