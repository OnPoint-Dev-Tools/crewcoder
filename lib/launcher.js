import { spawn } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const AGENT_PACKAGE = "@onpoint-dev-tools/crewcoder-agent";
const TUI_PACKAGE_JSON = "@onpoint-dev-tools/crewcoder-tui/package.json";

/**
 * Resolve the installed CLI that should handle this invocation.
 * Bare `crewcoder` opens the TUI; argument-bearing calls use the agent CLI.
 *
 * @param {readonly string[]} args
 * @returns {string}
 */
export function resolveCrewCoderCli(args) {
  if (args.length === 0) {
    const packageJsonPath = require.resolve(TUI_PACKAGE_JSON);
    return path.join(path.dirname(packageJsonPath), "dist", "cli.js");
  }

  const agentEntryPath = require.resolve(AGENT_PACKAGE);
  return path.join(path.dirname(agentEntryPath), "cli.js");
}

/**
 * Run the selected CrewCoder package with inherited terminal I/O.
 *
 * @param {readonly string[]} args
 * @param {{ spawnProcess?: typeof spawn, nodePath?: string }} [options]
 * @returns {Promise<number>}
 */
export function runCrewCoder(args, options = {}) {
  const spawnProcess = options.spawnProcess ?? spawn;
  const nodePath = options.nodePath ?? process.execPath;
  const cliPath = resolveCrewCoderCli(args);

  return new Promise((resolve, reject) => {
    const child = spawnProcess(nodePath, [cliPath, ...args], {
      stdio: "inherit",
      env: process.env
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}
