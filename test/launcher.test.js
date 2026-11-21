import { EventEmitter } from "node:events";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { minimumVersion, resolveCrewCoderLaunch, runCrewCoder } from "../lib/launcher.js";

const agentEntryPath = path.resolve("fixtures/crewcoder-agent/dist/index.js");
const tuiPackageJsonPath = path.resolve("fixtures/crewcoder-opentui/package.json");
const legacyPackageJsonPath = path.resolve("fixtures/crewcoder-tui/package.json");
const openTuiCli = path.resolve("fixtures/crewcoder-opentui/dist/cli.js");
const legacyCli = path.resolve("fixtures/crewcoder-tui/dist/cli.js");
const resolveModule = (specifier) => {
  if (specifier === "@onpoint-dev-tools/crewcoder-opentui/package.json") return tuiPackageJsonPath;
  if (specifier === "@onpoint-dev-tools/crewcoder-tui/package.json") return legacyPackageJsonPath;
  if (specifier === "@onpoint-dev-tools/crewcoder-agent") return agentEntryPath;
  throw new Error(`Cannot find module '${specifier}'`);
};
const readJson = () => ({ engines: { node: ">=26.4.0" } });
const tty = { resolveModule, readJson, nodeVersion: "26.13.1", interactive: true };
const without = (fragment) => (specifier) => {
  if (specifier.includes(fragment)) throw new Error("Cannot find module");
  return resolveModule(specifier);
};
const withoutOpenTui = without("crewcoder-opentui");
const withoutAnyTui = (specifier) => {
  if (specifier.includes("crewcoder-opentui") || specifier.includes("crewcoder-tui/")) throw new Error("Cannot find module");
  return resolveModule(specifier);
};

describe("CrewCoder umbrella launcher", () => {
  it("selects the OpenTUI terminal UI for a bare interactive invocation", () => {
    expect(resolveCrewCoderLaunch([], tty)).toEqual({ ui: "opentui", cliPath: openTuiCli, nodeArgs: ["--disable-warning=ExperimentalWarning"] });
  });

  it("selects the agent for argument-bearing commands without probing either TUI", () => {
    const options = { ...tty, interactive: false, nodeVersion: "22.0.0", resolveModule: withoutAnyTui };
    expect(resolveCrewCoderLaunch(["providers"], options)).toEqual({ ui: "agent", cliPath: path.resolve("fixtures/crewcoder-agent/dist/cli.js"), nodeArgs: [] });
  });

  it("falls back to the legacy UI on a Node.js older than the OpenTUI engines floor", () => {
    for (const nodeVersion of ["22.13.1", "25.6.0", "26.3.9"]) {
      const plan = resolveCrewCoderLaunch([], { ...tty, nodeVersion });
      expect(plan.ui).toBe("legacy");
      expect(plan.cliPath).toBe(legacyCli);
      expect(plan.nodeArgs).toEqual([]);
      expect(plan.notice).toContain(`needs Node.js >=26.4.0 (current ${nodeVersion})`);
      expect(plan.notice).toContain("Using the legacy terminal UI instead");
      expect(plan.notice).toContain("upgrade Node.js to 26.4.0 or newer");
    }
    expect(resolveCrewCoderLaunch([], { ...tty, nodeVersion: "26.4.0" }).ui).toBe("opentui");
    expect(resolveCrewCoderLaunch([], { ...tty, nodeVersion: "27.0.0-pre" }).ui).toBe("opentui");
  });

  it("falls back to the legacy UI when npm skipped the optional OpenTUI package", () => {
    const plan = resolveCrewCoderLaunch([], { ...tty, resolveModule: withoutOpenTui });
    expect(plan.ui).toBe("legacy");
    expect(plan.cliPath).toBe(legacyCli);
    expect(plan.notice).toMatch(/crewcoder-opentui\) is not installed/);
    expect(plan.notice).toContain("npm install --global crewcoder");
  });

  it("explains how to recover when neither terminal UI is installed", () => {
    const options = { ...tty, nodeVersion: "22.13.1", resolveModule: withoutAnyTui };
    expect(() => resolveCrewCoderLaunch([], options)).toThrow(/crewcoder-tui\) is not installed either/);
    expect(() => resolveCrewCoderLaunch([], options)).toThrow(/crewcoder run/);
  });

  it("does not open either UI without an interactive terminal", () => {
    expect(() => resolveCrewCoderLaunch([], { ...tty, interactive: false })).toThrow(/needs an interactive terminal/);
    expect(() => resolveCrewCoderLaunch([], { ...tty, interactive: false, nodeVersion: "22.13.1" })).toThrow(/needs an interactive terminal/);
  });

  it("launches OpenTUI when the engines range is not a simple lower bound", () => {
    expect(resolveCrewCoderLaunch([], { ...tty, nodeVersion: "20.0.0", readJson: () => ({ engines: { node: "^26 || ^27" } }) }).ui).toBe("opentui");
    expect(resolveCrewCoderLaunch([], { ...tty, nodeVersion: "20.0.0", readJson: () => ({}) }).ui).toBe("opentui");
  });

  it("forwards arguments and the child exit code", async () => {
    const child = new EventEmitter();
    const spawnProcess = vi.fn(() => child);
    const writeNotice = vi.fn();
    const result = runCrewCoder(["run", "check this"], { ...tty, spawnProcess, writeNotice, nodePath: "/node" });

    child.emit("close", 7, null);

    await expect(result).resolves.toBe(7);
    expect(spawnProcess).toHaveBeenCalledWith(
      "/node",
      [path.resolve("fixtures/crewcoder-agent/dist/cli.js"), "run", "check this"],
      { stdio: "inherit", env: process.env }
    );
    expect(writeNotice).not.toHaveBeenCalled();
  });

  it("silences only the FFI experimental notice when spawning OpenTUI", async () => {
    const child = new EventEmitter();
    const spawnProcess = vi.fn(() => child);
    const writeNotice = vi.fn();
    const result = runCrewCoder([], { ...tty, spawnProcess, writeNotice, nodePath: "/node" });

    child.emit("close", 0, null);

    await expect(result).resolves.toBe(0);
    expect(spawnProcess).toHaveBeenCalledWith("/node", ["--disable-warning=ExperimentalWarning", openTuiCli], { stdio: "inherit", env: process.env });
    expect(writeNotice).not.toHaveBeenCalled();
  });

  it("spawns the legacy UI without FFI flags and prints the notice before and after it runs", async () => {
    const child = new EventEmitter();
    const spawnProcess = vi.fn(() => child);
    const writeNotice = vi.fn();
    const result = runCrewCoder([], { ...tty, nodeVersion: "25.6.0", spawnProcess, writeNotice, nodePath: "/node" });

    expect(writeNotice).toHaveBeenCalledTimes(1);
    expect(spawnProcess).toHaveBeenCalledWith("/node", [legacyCli], { stdio: "inherit", env: process.env });
    child.emit("close", 3, null);

    await expect(result).resolves.toBe(3);
    expect(writeNotice).toHaveBeenCalledTimes(2);
    const [[before], [after]] = writeNotice.mock.calls;
    expect(before).toBe(after);
    expect(before).toMatch(/^crewcoder: The new terminal UI needs Node\.js >=26\.4\.0 \(current 25\.6\.0\)\..*\n$/);
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
