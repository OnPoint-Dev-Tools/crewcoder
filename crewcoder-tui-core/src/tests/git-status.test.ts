import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readGitLabel, readGitLabelAsync, readGitRepoName } from "../state/git-status.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "crew-git-")));
  roots.push(root);
  return root;
}

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "init.defaultBranch=main", ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

describe("readGitLabelAsync", () => {
  it("matches readGitLabel: branch, a * once the tree is dirty, nothing outside git", async () => {
    const repo = tempDir();
    expect(await readGitLabelAsync(repo)).toBeUndefined();
    git(repo, "init", "-q");
    git(repo, "commit", "-q", "--allow-empty", "-m", "init");
    expect(await readGitLabelAsync(repo)).toBe("main");
    fs.writeFileSync(path.join(repo, "new.txt"), "x");
    expect(await readGitLabelAsync(repo)).toBe("main*");
    expect(await readGitLabelAsync(repo)).toBe(readGitLabel(repo));
  });
});

describe("readGitRepoName", () => {
  it("names a normal clone by its folder, from any subdirectory", () => {
    const repo = path.join(tempDir(), "my-project");
    fs.mkdirSync(path.join(repo, "src", "deep"), { recursive: true });
    git(repo, "init", "-q");
    expect(readGitRepoName(repo)).toBe("my-project");
    expect(readGitRepoName(path.join(repo, "src", "deep"))).toBe("my-project");
  });

  it("names a linked worktree by its main repository, not the worktree folder", () => {
    const root = tempDir();
    const repo = path.join(root, "crewcoder");
    fs.mkdirSync(repo);
    git(repo, "init", "-q");
    git(repo, "commit", "-q", "--allow-empty", "-m", "init");
    const worktree = path.join(root, "wt-feature");
    git(repo, "worktree", "add", "-q", worktree);
    expect(readGitRepoName(worktree)).toBe("crewcoder");
  });

  it("names a bare repository without its .git suffix", () => {
    const bare = path.join(tempDir(), "service.git");
    fs.mkdirSync(bare);
    git(bare, "init", "-q", "--bare");
    expect(readGitRepoName(bare)).toBe("service");
  });

  it("is undefined outside a repository", () => {
    expect(readGitRepoName(tempDir())).toBeUndefined();
  });
});
