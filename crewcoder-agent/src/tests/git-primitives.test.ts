import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { gitBlameTool, gitCherryPickTool, gitDiffRangeTool, gitLogTool } from "../tools/git-primitives.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function repository(): Promise<{ cwd: string; first: string; second: string }> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "crewcoder-git-tools-"));
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "test@example.com"]);
  git(cwd, ["config", "user.name", "Test User"]);
  git(cwd, ["config", "commit.gpgsign", "false"]);
  await fs.writeFile(path.join(cwd, "file.txt"), "one\ntwo\n", "utf8");
  git(cwd, ["add", "file.txt"]);
  git(cwd, ["commit", "-m", "initial commit"]);
  const first = git(cwd, ["rev-parse", "HEAD"]);
  await fs.writeFile(path.join(cwd, "file.txt"), "one\nchanged\nthree\n", "utf8");
  git(cwd, ["add", "file.txt"]);
  git(cwd, ["commit", "-m", "update file", "-m", "Structured body"]);
  return { cwd, first, second: git(cwd, ["rev-parse", "HEAD"]) };
}

const context = (cwd: string) => ({ cwd, mode: "general" as const, sessionId: "test", mutationLog: [] as string[] });

describe("Git primitive tools", () => {
  it("returns structured blame lines", async () => {
    const repo = await repository();
    const result = await gitBlameTool.execute({ path: "file.txt", startLine: 2, endLine: 3, revision: undefined }, context(repo.cwd));
    const lines = result.details?.lines as Array<Record<string, unknown>>;
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ line: 2, author: "Test User", text: "changed" });
    expect(lines[0]?.commit).toBe(repo.second);
  });

  it("returns structured commit history", async () => {
    const repo = await repository();
    const result = await gitLogTool.execute({ maxCount: 2, revision: undefined, path: undefined }, context(repo.cwd));
    const commits = result.details?.commits as Array<Record<string, unknown>>;
    expect(commits).toHaveLength(2);
    expect(commits[0]).toMatchObject({ hash: repo.second, subject: "update file", body: "Structured body", author: { name: "Test User", email: "test@example.com" } });
    expect(commits[1]).toMatchObject({ hash: repo.first, subject: "initial commit" });
  });

  it("returns a structured range summary and patch", async () => {
    const repo = await repository();
    const result = await gitDiffRangeTool.execute({ from: repo.first, to: repo.second, path: undefined, contextLines: 1 }, context(repo.cwd));
    expect(result.details?.files).toEqual([{ path: "file.txt", additions: 2, deletions: 1, binary: false }]);
    expect(result.details?.patch).toContain("+changed");
    expect(result.content[0]?.text).toContain("diff --git");
  });

  it("cherry-picks a commit and records changed files", async () => {
    const repo = await repository();
    git(repo.cwd, ["checkout", "-b", "feature", repo.first]);
    await fs.writeFile(path.join(repo.cwd, "feature.txt"), "feature\n", "utf8");
    git(repo.cwd, ["add", "feature.txt"]);
    git(repo.cwd, ["commit", "-m", "feature commit"]);
    const featureCommit = git(repo.cwd, ["rev-parse", "HEAD"]);
    git(repo.cwd, ["checkout", "main"]);
    const ctx = context(repo.cwd);

    const result = await gitCherryPickTool.execute({ commit: featureCommit }, ctx);
    expect(await fs.readFile(path.join(repo.cwd, "feature.txt"), "utf8")).toBe("feature\n");
    expect(ctx.mutationLog).toEqual(["feature.txt"]);
    expect(result.details).toMatchObject({ sourceCommit: featureCommit, changedFiles: ["feature.txt"], commit: { subject: "feature commit" } });
  });

  it("rejects option injection and dirty cherry-picks", async () => {
    const repo = await repository();
    await expect(gitLogTool.execute({ maxCount: 2, revision: "--all", path: undefined }, context(repo.cwd))).rejects.toThrow("Invalid Git revision");
    await fs.writeFile(path.join(repo.cwd, "dirty.txt"), "dirty\n", "utf8");
    await expect(gitCherryPickTool.execute({ commit: repo.first }, context(repo.cwd))).rejects.toThrow("clean worktree");
  });
});
