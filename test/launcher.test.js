import { EventEmitter } from "node:events";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveCrewCoderCli, runCrewCoder } from "../lib/launcher.js";

describe("CrewCoder umbrella launcher", () => {
  it("selects the TUI for a bare invocation", () => {
    expect(resolveCrewCoderCli([])).toBe(path.resolve("crewcoder-tui/dist/cli.js"));
  });

  it("selects the agent for argument-bearing commands", () => {
    expect(resolveCrewCoderCli(["providers"])).toBe(path.resolve("crewcoder-agent/dist/cli.js"));
  });

  it("forwards arguments and the child exit code", async () => {
    const child = new EventEmitter();
    const spawnProcess = vi.fn(() => child);
    const result = runCrewCoder(["run", "check this"], { spawnProcess, nodePath: "/node" });

    child.emit("close", 7, null);

    await expect(result).resolves.toBe(7);
    expect(spawnProcess).toHaveBeenCalledWith(
      "/node",
      [path.resolve("crewcoder-agent/dist/cli.js"), "run", "check this"],
      { stdio: "inherit", env: process.env }
    );
  });

  it("reports launcher failures", async () => {
    const child = new EventEmitter();
    const result = runCrewCoder(["--version"], { spawnProcess: () => child });
    const failure = new Error("spawn failed");

    child.emit("error", failure);

    await expect(result).rejects.toBe(failure);
  });
});
