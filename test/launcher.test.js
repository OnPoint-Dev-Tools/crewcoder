import { EventEmitter } from "node:events";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveCrewCoderCli, runCrewCoder } from "../lib/launcher.js";

const agentEntryPath = path.resolve("fixtures/crewcoder-agent/dist/index.js");
const tuiPackageJsonPath = path.resolve("fixtures/crewcoder-tui/package.json");
const resolveModule = (specifier) => specifier.endsWith("/package.json") ? tuiPackageJsonPath : agentEntryPath;

describe("CrewCoder umbrella launcher", () => {
  it("selects the TUI for a bare invocation", () => {
    expect(resolveCrewCoderCli([], resolveModule)).toBe(path.resolve("fixtures/crewcoder-tui/dist/cli.js"));
  });

  it("selects the agent for argument-bearing commands", () => {
    expect(resolveCrewCoderCli(["providers"], resolveModule)).toBe(path.resolve("fixtures/crewcoder-agent/dist/cli.js"));
  });

  it("forwards arguments and the child exit code", async () => {
    const child = new EventEmitter();
    const spawnProcess = vi.fn(() => child);
    const result = runCrewCoder(["run", "check this"], { spawnProcess, nodePath: "/node", resolveModule });

    child.emit("close", 7, null);

    await expect(result).resolves.toBe(7);
    expect(spawnProcess).toHaveBeenCalledWith(
      "/node",
      [path.resolve("fixtures/crewcoder-agent/dist/cli.js"), "run", "check this"],
      { stdio: "inherit", env: process.env }
    );
  });

  it("reports launcher failures", async () => {
    const child = new EventEmitter();
    const result = runCrewCoder(["--version"], { spawnProcess: () => child, resolveModule });
    const failure = new Error("spawn failed");

    child.emit("error", failure);

    await expect(result).rejects.toBe(failure);
  });
});
