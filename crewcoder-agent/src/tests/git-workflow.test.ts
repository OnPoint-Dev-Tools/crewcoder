import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createGitWorkflowHelpers, extractIssueReferences, issueBaseUrlFromRemote, parsePorcelainStatus } from "../core/git-workflow.js";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

describe("git workflow helpers", () => {
  it("extracts issue references", () => {
    expect(extractIssueReferences("feature/GH-123-fix and issue_456", "branch")).toEqual([
      { id: "123", source: "branch", text: "GH-123", url: undefined },
      { id: "456", source: "branch", text: "issue_456", url: undefined }
    ]);
  });

  it("builds issue base URLs from known git remotes", () => {
    expect(issueBaseUrlFromRemote("git@github.com:owner/repo.git")).toBe("https://github.com/owner/repo/issues");
    expect(issueBaseUrlFromRemote("https://gitlab.com/owner/repo.git")).toBe("https://gitlab.com/owner/repo/-/issues");
  });

  it("parses porcelain status entries", () => {
    expect(parsePorcelainStatus(" M README.md\nR  old.ts -> new.ts\n?? scratch.txt")).toEqual([
      { path: "README.md", index: " ", workingTree: "M", raw: " M README.md" },
      { path: "new.ts", index: "R", workingTree: " ", raw: "R  old.ts -> new.ts" },
      { path: "scratch.txt", index: "?", workingTree: "?", raw: "?? scratch.txt" }
    ]);
  });

  it("reports branch/status/changed files and creates checkpoints", async () => {
    const previousHome = process.env.CREWCODER_HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-home-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-git-"));
    process.env.CREWCODER_HOME = home;
    try {
      git(cwd, ["init"]);
      git(cwd, ["config", "user.email", "test@example.com"]);
      git(cwd, ["config", "user.name", "Test"]);
      git(cwd, ["checkout", "-b", "feature/GH-123-workflow"]);
      fs.writeFileSync(path.join(cwd, "README.md"), "before\n", "utf8");
      git(cwd, ["add", "README.md"]);
      fs.writeFileSync(path.join(cwd, "README.md"), "after\n", "utf8");
      fs.writeFileSync(path.join(cwd, "scratch.txt"), "scratch\n", "utf8");

      const helpers = createGitWorkflowHelpers({ cwd, sessionId: "session_git" });
      expect(await helpers.currentBranch()).toBe("feature/GH-123-workflow");
      expect(await helpers.changedFiles()).toEqual(["README.md", "scratch.txt"]);
      const status = await helpers.status();
      expect(status.clean).toBe(false);
      expect(status.entries.map((entry) => entry.path)).toEqual(["README.md", "scratch.txt"]);
      expect(await helpers.issueReferences()).toContainEqual({ id: "123", source: "branch", text: "GH-123", url: undefined });
      const review = await helpers.reviewSummary();
      expect(review.issueReferences).toContainEqual({ id: "123", source: "branch", text: "GH-123", url: undefined });
      expect(review.changedFiles).toEqual(["README.md", "scratch.txt"]);
      const checkpoint = await helpers.createCheckpoint("git helper test");
      expect(checkpoint.reason).toBe("git helper test");
      expect(checkpoint.fileCount).toBeGreaterThan(0);
    } finally {
      if (previousHome === undefined) delete process.env.CREWCODER_HOME;
      else process.env.CREWCODER_HOME = previousHome;
    }
  });
});
