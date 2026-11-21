import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const AGENT_PACKAGE = "@onpoint-dev-tools/crewcoder-agent";
const TUI_PACKAGE = "@onpoint-dev-tools/crewcoder-opentui";
const LEGACY_TUI_PACKAGE = "@onpoint-dev-tools/crewcoder-tui";
const HEADLESS_HINT = "Agent commands still work without it, for example `crewcoder run \"<prompt>\"` (see `crewcoder --help`).";
const LEGACY_HINT = `The legacy terminal UI runs on Node.js 22+: \`npm i -g ${LEGACY_TUI_PACKAGE}\`, then \`crewcoder-tui\`.`;

/**
 * @typedef {{
 *   resolveModule?: (specifier: string) => string,
 *   readJson?: (filePath: string) => unknown,
 *   nodeVersion?: string,
 *   interactive?: boolean
 * }} ResolveOptions
 */

/**
 * Resolve the installed CLI that should handle this invocation.
 * Bare `crewcoder` opens the OpenTUI terminal UI; argument-bearing calls use the agent CLI.
 * The TUI is an optional dependency, so a bare call fails with guidance instead of a stack
 * trace when it is missing, the Node.js runtime is too old, or there is no terminal.
 *
 * @param {readonly string[]} args
 * @param {ResolveOptions} [options]
 * @returns {string}
 */
export function resolveCrewCoderCli(args, options = {}) {
  const {
    resolveModule = require.resolve,
    readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, "utf8")),
    nodeVersion = process.versions.node,
    interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY)
  } = options;

  if (args.length > 0) {
    const agentEntryPath = resolveModule(AGENT_PACKAGE);
    return path.join(path.dirname(agentEntryPath), "cli.js");
  }

  if (!interactive) {
    throw new Error(`The terminal UI needs an interactive terminal. ${HEADLESS_HINT}`);
  }

  let packageJsonPath;
  try {
    packageJsonPath = resolveModule(`${TUI_PACKAGE}/package.json`);
  } catch {
    throw new Error(`The terminal UI (${TUI_PACKAGE}) is not installed. It is optional and npm skips it on unsupported Node.js versions or platforms without an OpenTUI native build. ${LEGACY_HINT} ${HEADLESS_HINT}`);
  }

  const manifest = /** @type {{ engines?: { node?: unknown } }} */ (readJson(packageJsonPath));
  const required = typeof manifest?.engines?.node === "string" ? minimumVersion(manifest.engines.node) : undefined;
  if (required && compareVersions(nodeVersion, required) < 0) {
    throw new Error(`The terminal UI needs Node.js >=${required} (current ${nodeVersion}). Upgrade Node.js to use it. ${LEGACY_HINT} ${HEADLESS_HINT}`);
  }
  return path.join(path.dirname(packageJsonPath), "dist", "cli.js");
}

/**
 * Run the selected CrewCoder package with inherited terminal I/O.
 *
 * @param {readonly string[]} args
 * @param {ResolveOptions & { spawnProcess?: typeof spawn, nodePath?: string }} [options]
 * @returns {Promise<number>}
 */
export function runCrewCoder(args, options = {}) {
  const spawnProcess = options.spawnProcess ?? spawn;
  const nodePath = options.nodePath ?? process.execPath;
  const cliPath = resolveCrewCoderCli(args, options);
  // OpenTUI loads its native layer through Node's experimental FFI; keep that
  // runtime notice from printing above the TUI. Agent invocations are unchanged.
  const nodeArgs = args.length === 0 ? ["--disable-warning=ExperimentalWarning"] : [];

  return new Promise((resolve, reject) => {
    const child = spawnProcess(nodePath, [...nodeArgs, cliPath, ...args], {
      stdio: "inherit",
      env: process.env
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}

/**
 * Extract the lower bound from a simple `>=x.y.z` engines range. Other range
 * shapes return undefined so the launcher never blocks on a range it cannot read.
 *
 * @param {string} range
 * @returns {string | undefined}
 */
export function minimumVersion(range) {
  return /^\s*>=\s*v?(\d+\.\d+\.\d+)\s*$/.exec(range)?.[1];
}

/**
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
function compareVersions(left, right) {
  const leftParts = left.replace(/^v/, "").split(/[.-]/).slice(0, 3).map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
