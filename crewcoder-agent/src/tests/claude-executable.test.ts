import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveClaudeExecutable } from "../providers/claude-executable.js";
import { isolatedCrewCoderTestHome } from "./test-home-setup.js";

describe("Claude executable selection", () => {
  it("prefers an explicit override, including an invalid path so configuration errors are visible", () => {
    expect(resolveClaudeExecutable({ CREWCODER_CLAUDE_PATH: "/explicit/claude", PATH: "" })).toBe("/explicit/claude");
  });

  it("uses the first executable file on PATH and skips directories and non-executable files", () => {
    fs.mkdirSync(isolatedCrewCoderTestHome, { recursive: true });
    const root = fs.mkdtempSync(path.join(isolatedCrewCoderTestHome, "claude-path-"));
    const dirs = ["directory", "non-executable", "installed", "second"].map((name) => path.join(root, name));
    for (const dir of dirs) fs.mkdirSync(dir);
    const name = process.platform === "win32" ? "claude.exe" : "claude";
    fs.mkdirSync(path.join(dirs[0], name));
    fs.writeFileSync(path.join(dirs[1], name), "blocked", { mode: 0o600 });
    fs.writeFileSync(path.join(dirs[2], name), "#!/bin/sh\n", { mode: 0o755 });
    fs.writeFileSync(path.join(dirs[3], name), "#!/bin/sh\n", { mode: 0o755 });
    const search = process.platform === "win32" ? dirs.slice(2) : dirs;
    expect(resolveClaudeExecutable({ PATH: search.join(path.delimiter) })).toBe(fs.realpathSync(path.join(dirs[2], name)));
  });

  it("uses the SDK bundle when there is no installed CLI", () => {
    expect(resolveClaudeExecutable({ PATH: "" })).toBeUndefined();
    expect(resolveClaudeExecutable({ PATH: path.join(isolatedCrewCoderTestHome, "missing") })).toBeUndefined();
  });
});
