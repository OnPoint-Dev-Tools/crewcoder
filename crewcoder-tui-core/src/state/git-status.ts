import { spawnSync } from "node:child_process";

export function readGitLabel(cwd: string): string | undefined {
  const insideWorkTree = runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (insideWorkTree !== "true") return undefined;

  const branch = runGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const revision = branch ?? runGit(cwd, ["rev-parse", "--short", "HEAD"]);
  if (!revision) return undefined;

  const dirty = runGit(cwd, ["status", "--porcelain"])?.length;
  return `${revision}${dirty ? "*" : ""}`;
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
