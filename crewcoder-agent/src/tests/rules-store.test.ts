import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadCrewCoderRules, readRulesContext, resolveRulesDir } from "../core/rules-store.js";

let cwd: string;

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-rules-"));
  fs.mkdirSync(resolveRulesDir(cwd), { recursive: true });
});

afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe("repository rules", () => {
  it("loads always-on rules before matching path-scoped rules", () => {
    fs.writeFileSync(path.join(resolveRulesDir(cwd), "common.md"), "# Common\nAlways verify changes.\n");
    fs.mkdirSync(path.join(resolveRulesDir(cwd), "typescript"));
    fs.writeFileSync(path.join(resolveRulesDir(cwd), "typescript", "coding.md"), [
      "---", "paths:", "  - \"**/*.ts\"", "  - '**/*.tsx'", "---", "# TypeScript", "Avoid any."
    ].join("\n"));
    fs.writeFileSync(path.join(cwd, "index.ts"), "export {};\n");

    const rules = loadCrewCoderRules(cwd);
    expect(rules.map((rule) => rule.relativeFile)).toEqual(["common.md", "typescript/coding.md"]);
    expect(rules[1]?.paths).toEqual(["**/*.ts", "**/*.tsx"]);
    const context = readRulesContext(cwd);
    expect(context).toContain("Always verify changes.");
    expect(context).toContain("Avoid any.");
    expect(context?.indexOf("common.md")).toBeLessThan(context?.indexOf("typescript/coding.md") ?? 0);
  });

  it("omits scoped rules when the workspace has no matching file", () => {
    fs.writeFileSync(path.join(resolveRulesDir(cwd), "python.md"), "---\npaths:\n  - '**/*.py'\n---\nUse pytest.\n");
    fs.writeFileSync(path.join(cwd, "index.ts"), "export {};\n");

    expect(loadCrewCoderRules(cwd)).toEqual([]);
    expect(readRulesContext(cwd)).toBeNull();
  });

  it("ignores oversized files and symlinks", () => {
    fs.writeFileSync(path.join(resolveRulesDir(cwd), "large.md"), "x".repeat(12_001));
    fs.writeFileSync(path.join(cwd, "outside.md"), "Do not load me.\n");
    fs.symlinkSync(path.join(cwd, "outside.md"), path.join(resolveRulesDir(cwd), "linked.md"));
    fs.writeFileSync(path.join(resolveRulesDir(cwd), "valid.md"), "Load me.\n");

    expect(loadCrewCoderRules(cwd).map((rule) => rule.relativeFile)).toEqual(["valid.md"]);
  });

  it("bounds total injected context", () => {
    for (let index = 0; index < 4; index++) {
      fs.writeFileSync(path.join(resolveRulesDir(cwd), `${index}.md`), `${index}\n${"x".repeat(8_000)}`);
    }
    const context = readRulesContext(cwd);
    expect(context?.length).toBeLessThanOrEqual(24_040);
    expect(context).toContain("repository rules truncated");
  });
});
