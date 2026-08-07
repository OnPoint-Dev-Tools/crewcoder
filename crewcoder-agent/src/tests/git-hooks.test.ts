import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { installPreCommitHookAtPath, renderPreCommitHook } from "../core/git-hooks.js";

function fixture(): { root: string; hookPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-hook-"));
  return { root, hookPath: path.join(root, ".git", "hooks", "pre-commit") };
}

describe("CrewCoder pre-commit hook", () => {
  it("renders a read-only CI review with safely quoted values", () => {
    const hook = renderPreCommitHook({ command: "/opt/Crew Coder/bin/crewcoder", budget: "100k" });
    expect(hook).toContain("CREWCODER_COMMAND='/opt/Crew Coder/bin/crewcoder'");
    expect(hook).toContain("--approval always --budget '100k'");
    expect(hook).toContain("git diff --cached");
    expect(hook).toContain("CREWCODER_REVIEW_RESULT: PASS");
    expect(hook).toContain("CREWCODER_REVIEW_RESULT: FAIL");
  });

  it("installs idempotently and marks the hook executable", () => {
    const test = fixture();
    const installed = installPreCommitHookAtPath(test.hookPath, { repoRoot: test.root });
    const unchanged = installPreCommitHookAtPath(test.hookPath, { repoRoot: test.root });
    expect(installed.status).toBe("installed");
    expect(unchanged.status).toBe("unchanged");
    expect(fs.statSync(test.hookPath).mode & 0o111).not.toBe(0);
  });

  it("preserves custom content outside the managed block when updating", () => {
    const test = fixture();
    installPreCommitHookAtPath(test.hookPath, { repoRoot: test.root });
    fs.appendFileSync(test.hookPath, "echo custom-after\n", "utf8");

    const updated = installPreCommitHookAtPath(test.hookPath, { repoRoot: test.root, budget: "50k" });
    const content = fs.readFileSync(test.hookPath, "utf8");
    expect(updated.status).toBe("updated");
    expect(content).toContain("--budget '50k'");
    expect(content).toContain("echo custom-after");
  });

  it("refuses an unrelated hook unless force backs it up", () => {
    const test = fixture();
    fs.mkdirSync(path.dirname(test.hookPath), { recursive: true });
    fs.writeFileSync(test.hookPath, "#!/bin/sh\necho existing\n", "utf8");

    expect(() => installPreCommitHookAtPath(test.hookPath, { repoRoot: test.root })).toThrow(/non-CrewCoder/);
    const replaced = installPreCommitHookAtPath(test.hookPath, { repoRoot: test.root, force: true });
    expect(replaced.status).toBe("replaced");
    expect(replaced.backupPath && fs.readFileSync(replaced.backupPath, "utf8")).toContain("echo existing");
  });
});
