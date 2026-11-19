import { execFile, spawnSync } from "node:child_process";
import path from "node:path";

export function readGitLabel(cwd: string): string | undefined {
  const insideWorkTree = runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (insideWorkTree !== "true") return undefined;

  const branch = runGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const revision = branch ?? runGit(cwd, ["rev-parse", "--short", "HEAD"]);
  if (!revision) return undefined;

  const dirty = runGit(cwd, ["status", "--porcelain"])?.length;
  return `${revision}${dirty ? "*" : ""}`;
}

/**
 * `readGitLabel` without blocking: `git status` can take a while in a large
 * repository, so refreshes after each run use this.
 */
export async function readGitLabelAsync(cwd: string): Promise<string | undefined> {
  if (await runGitAsync(cwd, ["rev-parse", "--is-inside-work-tree"]) !== "true") return undefined;
  const branch = await runGitAsync(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const revision = branch ?? await runGitAsync(cwd, ["rev-parse", "--short", "HEAD"]);
  if (!revision) return undefined;
  const dirty = (await runGitAsync(cwd, ["status", "--porcelain"]))?.length;
  return `${revision}${dirty ? "*" : ""}`;
}

/**
 * The repository's name: the directory holding its shared `.git`, so linked
 * worktrees report the main repo (`crewcoder`), not the worktree folder.
 * Undefined outside a git repository.
 */
export function readGitRepoName(cwd: string): string | undefined {
  const commonDir = runGit(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!commonDir) return undefined;
  const trimmed = commonDir.replace(/[\\/]+$/, "");
  // `<repo>/.git` for normal clones; a bare repo is `<name>.git` itself.
  const repoDir = path.basename(trimmed) === ".git" ? path.dirname(trimmed) : trimmed;
  return path.basename(repoDir).replace(/\.git$/, "") || undefined;
}

function runGit(cwd: string, args: string[]): string | undefined {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  if (result.status !== 0) return undefined;
  const output = result.stdout.trim();
  return output || undefined;
}

function runGitAsync(cwd: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("git", ["-C", cwd, ...args], { encoding: "utf8" }, (error, stdout) => {
      resolve(error ? undefined : stdout.trim() || undefined);
    });
  });
}
