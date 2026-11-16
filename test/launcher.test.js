import { EventEmitter } from "node:events";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { minimumVersion, resolveCrewCoderCli, runCrewCoder } from "../lib/launcher.js";

const agentEntryPath = path.resolve("fixtures/crewcoder-agent/dist/index.js");
const tuiPackageJsonPath = path.resolve("fixtures/crewcoder-opentui/package.json");
const resolveModule = (specifier) => {
  if (specifier === "@onpoint-dev-tools/crewcoder-opentui/package.json") return tuiPackageJsonPath;
  if (specifier === "@onpoint-dev-tools/crewcoder-agent") return agentEntryPath;
  throw new Error(`Cannot find module '${specifier}'`);
};
const readJson = () => ({ engines: { node: ">=26.4.0" } });
const tty = { resolveModule, readJson, nodeVersion: "26.13.1", interactive: true };

describe("CrewCoder umbrella launcher", () => {
  it("selects the OpenTUI terminal UI for a bare interactive invocation", () => {
    expect(resolveCrewCoderCli([], tty)).toBe(path.resolve("fixtures/crewcoder-opentui/dist/cli.js"));
  });

  it("selects the agent for argument-bearing commands without probing the TUI", () => {
    const options = { ...tty, interactive: false, nodeVersion: "22.0.0", resolveModule: (specifier) => {
      if (specifier.includes("opentui")) throw new Error("TUI must not be resolved");
      return resolveModule(specifier);
    } };
    expect(resolveCrewCoderCli(["providers"], options)).toBe(path.resolve("fixtures/crewcoder-agent/dist/cli.js"));
  });

  it("explains the missing optional TUI and points at the legacy UI and agent commands", () => {
    const options = { ...tty, resolveModule: (specifier) => {
      if (specifier.includes("opentui")) throw new Error("Cannot find module");
      return resolveModule(specifier);
    } };
    expect(() => resolveCrewCoderCli([], options)).toThrow(/crewcoder-opentui\) is not installed/);
    expect(() => resolveCrewCoderCli([], options)).toThrow(/@onpoint-dev-tools\/crewcoder-tui/);
    expect(() => resolveCrewCoderCli([], options)).toThrow(/crewcoder run/);
  });

  it("refuses to launch the TUI on a Node.js older than its engines floor", () => {
    expect(() => resolveCrewCoderCli([], { ...tty, nodeVersion: "22.13.1" })).toThrow(/needs Node\.js >=26\.4\.0 \(current 22\.13\.1\)/);
    expect(() => resolveCrewCoderCli([], { ...tty, nodeVersion: "26.3.9" })).toThrow(/needs Node\.js >=26\.4\.0/);
    expect(resolveCrewCoderCli([], { ...tty, nodeVersion: "26.4.0" })).toContain("crewcoder-opentui");
    expect(resolveCrewCoderCli([], { ...tty, nodeVersion: "27.0.0-pre" })).toContain("crewcoder-opentui");
  });

  it("does not open the TUI without an interactive terminal", () => {
    expect(() => resolveCrewCoderCli([], { ...tty, interactive: false })).toThrow(/needs an interactive terminal/);
  });

  it("launches when the engines range is not a simple lower bound", () => {
    expect(resolveCrewCoderCli([], { ...tty, nodeVersion: "20.0.0", readJson: () => ({ engines: { node: "^26 || ^27" } }) })).toContain("crewcoder-opentui");
    expect(resolveCrewCoderCli([], { ...tty, nodeVersion: "20.0.0", readJson: () => ({}) })).toContain("crewcoder-opentui");
  });

  it("forwards arguments and the child exit code", async () => {
    const child = new EventEmitter();
    const spawnProcess = vi.fn(() => child);
    const result = runCrewCoder(["run", "check this"], { ...tty, spawnProcess, nodePath: "/node" });

    child.emit("close", 7, null);

    await expect(result).resolves.toBe(7);
    expect(spawnProcess).toHaveBeenCalledWith(
      "/node",
      [path.resolve("fixtures/crewcoder-agent/dist/cli.js"), "run", "check this"],
      { stdio: "inherit", env: process.env }
    );
  });

  it("silences only the FFI experimental notice when spawning the TUI", async () => {
    const child = new EventEmitter();
    const spawnProcess = vi.fn(() => child);
    const result = runCrewCoder([], { ...tty, spawnProcess, nodePath: "/node" });

    child.emit("close", 0, null);

    await expect(result).resolves.toBe(0);
    expect(spawnProcess).toHaveBeenCalledWith(
      "/node",
      ["--disable-warning=ExperimentalWarning", path.resolve("fixtures/crewcoder-opentui/dist/cli.js")],
      { stdio: "inherit", env: process.env }
    );
  });

  it("reports launcher failures", async () => {
    const child = new EventEmitter();
    const result = runCrewCoder(["--version"], { ...tty, spawnProcess: () => child });
    const failure = new Error("spawn failed");

    child.emit("error", failure);

    await expect(result).rejects.toBe(failure);
  });
});

describe("minimumVersion", () => {
  it("reads simple lower-bound engines ranges only", () => {
    expect(minimumVersion(">=26.4.0")).toBe("26.4.0");
    expect(minimumVersion(" >= v22.0.0 ")).toBe("22.0.0");
    expect(minimumVersion("^26.4.0")).toBeUndefined();
    expect(minimumVersion(">=26")).toBeUndefined();
  });
});
