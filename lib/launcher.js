import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const AGENT_PACKAGE = "@onpoint-dev-tools/crewcoder-agent";
const TUI_PACKAGE = "@onpoint-dev-tools/crewcoder-opentui";
const LEGACY_TUI_PACKAGE = "@onpoint-dev-tools/crewcoder-tui";
const HEADLESS_HINT = "Agent commands still work without it, for example `crewcoder run \"<prompt>\"` (see `crewcoder --help`).";
// OpenTUI loads its native layer through Node's experimental FFI; keep that
// runtime notice from printing above the TUI. Other children are unchanged.
const OPENTUI_NODE_ARGS = ["--disable-warning=ExperimentalWarning"];

/**
 * @typedef {{
 *   resolveModule?: (specifier: string) => string,
 *   readJson?: (filePath: string) => unknown,
 *   nodeVersion?: string,
 *   interactive?: boolean
 * }} ResolveOptions
 *
 * @typedef {{
 *   ui: "agent" | "opentui" | "legacy",
 *   cliPath: string,
 *   nodeArgs: string[],
 *   notice?: string
 * }} LaunchPlan
 */

/**
 * Decide which installed CLI handles this invocation.
 * Argument-bearing calls use the agent CLI. A bare call opens the OpenTUI terminal UI;
 * when OpenTUI cannot run here (not installed, or Node.js below its engines floor) it
 * opens the legacy terminal UI instead, with a notice explaining how to get OpenTUI.
 *
 * @param {readonly string[]} args
 * @param {ResolveOptions} [options]
 * @returns {LaunchPlan}
 */
export function resolveCrewCoderLaunch(args, options = {}) {
  const {
    resolveModule = require.resolve,
    readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, "utf8")),
    nodeVersion = process.versions.node,
    interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY)
  } = options;

  if (args.length > 0) {
    const agentEntryPath = resolveModule(AGENT_PACKAGE);
    return { ui: "agent", cliPath: path.join(path.dirname(agentEntryPath), "cli.js"), nodeArgs: [] };
  }

  if (!interactive) {
    throw new Error(`The terminal UI needs an interactive terminal. ${HEADLESS_HINT}`);
  }

  const openTui = checkOpenTui({ resolveModule, readJson, nodeVersion });
  if (!openTui.reason) {
    return { ui: "opentui", cliPath: path.join(path.dirname(openTui.packageJsonPath), "dist", "cli.js"), nodeArgs: OPENTUI_NODE_ARGS };
  }

  let legacyPackageJsonPath;
  try {
    legacyPackageJsonPath = resolveModule(`${LEGACY_TUI_PACKAGE}/package.json`);
  } catch {
    throw new Error(`${openTui.reason} The legacy terminal UI (${LEGACY_TUI_PACKAGE}) is not installed either; reinstall with \`npm install --global crewcoder\`. ${HEADLESS_HINT}`);
  }
  return {
    ui: "legacy",
    cliPath: path.join(path.dirname(legacyPackageJsonPath), "dist", "cli.js"),
    nodeArgs: [],
    notice: `${openTui.reason} Using the legacy terminal UI instead. ${openTui.remedy}`
  };
}

/**
 * @param {{ resolveModule: (specifier: string) => string, readJson: (filePath: string) => unknown, nodeVersion: string }} input
 * @returns {{ reason: undefined, packageJsonPath: string } | { reason: string, remedy: string }}
 */
function checkOpenTui({ resolveModule, readJson, nodeVersion }) {
  let packageJsonPath;
  try {
    packageJsonPath = resolveModule(`${TUI_PACKAGE}/package.json`);
  } catch {
    return {
      reason: `The new terminal UI (${TUI_PACKAGE}) is not installed; npm skips it on Node.js older than 26.4 and on platforms without an OpenTUI native build.`,
      remedy: "To use the new UI, switch to Node.js 26.4 or newer on a supported platform and reinstall: `npm install --global crewcoder`."
    };
  }

  const manifest = /** @type {{ engines?: { node?: unknown } }} */ (readJson(packageJsonPath));
  const required = typeof manifest?.engines?.node === "string" ? minimumVersion(manifest.engines.node) : undefined;
  if (required && compareVersions(nodeVersion, required) < 0) {
    return {
      reason: `The new terminal UI needs Node.js >=${required} (current ${nodeVersion}).`,
      remedy: `To use the new UI, upgrade Node.js to ${required} or newer and run \`crewcoder\` again.`
    };
  }
  return { reason: undefined, packageJsonPath };
}

/**
 * Run the selected CrewCoder package with inherited terminal I/O. A legacy fallback
 * prints its notice before the UI starts and again after it exits, because the UI
 * clears the screen while it runs.
 *
 * @param {readonly string[]} args
 * @param {ResolveOptions & { spawnProcess?: typeof spawn, nodePath?: string, writeNotice?: (text: string) => void }} [options]
 * @returns {Promise<number>}
 */
export function runCrewCoder(args, options = {}) {
  const spawnProcess = options.spawnProcess ?? spawn;
  const nodePath = options.nodePath ?? process.execPath;
  const writeNotice = options.writeNotice ?? ((text) => process.stderr.write(text));
  const plan = resolveCrewCoderLaunch(args, options);
  const notice = plan.notice ? `crewcoder: ${plan.notice}\n` : undefined;
  if (notice) writeNotice(notice);

  return new Promise((resolve, reject) => {
    const child = spawnProcess(nodePath, [...plan.nodeArgs, plan.cliPath, ...args], {
      stdio: "inherit",
      env: process.env
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (notice) writeNotice(notice);
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
