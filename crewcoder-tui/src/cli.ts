#!/usr/bin/env node
import { CrewCoderTui } from "./tui/tui.js";

const args = process.argv.slice(2);
const parsed = parseArgs(args);

if (parsed.help) {
  process.stdout.write(`CrewCoder TUI\n\nUsage:\n  crewcoder-tui [--theme <name-or-path>]\n  crewcoder-tui --remote <user@host> --remote-cwd <path> [--remote-bin <path>]\n\nRemote agent:\n  --remote user@vps         Run the CrewCoder backend through SSH\n  --remote-cwd /workspace   Remote project directory (defaults to ~)\n  --remote-bin <path>       Remote CrewCoder binary (defaults to ~/crewcoder-runner/crewcoder)\n\nTheme selection:\n  --theme dark              Use a built-in theme\n  --theme light             Use the built-in light theme\n  --theme ~/.crewcoder/themes/my-theme.json\n  CREWCODER_THEME=my-theme crewcoder-tui\n\nConfigure SSH keys and host verification before launching remote mode. Custom named themes are loaded from ~/.crewcoder/themes/<name>.json.\n`);
  process.exit(0);
}

try {
  if (parsed.remote) process.env.CREWCODER_REMOTE = parsed.remote;
  if (parsed.remoteCwd) process.env.CREWCODER_REMOTE_CWD = parsed.remoteCwd;
  if (parsed.remoteBin) process.env.CREWCODER_REMOTE_BIN = parsed.remoteBin;
  new CrewCoderTui(parsed.theme).start();
} catch (error) {
  process.stderr.write(`crewcoder-tui: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

export type ParsedArgs = { theme?: string; remote?: string; remoteCwd?: string; remoteBin?: string; help: boolean };

export function parseArgs(values: string[]): ParsedArgs {
  const result: ParsedArgs = { help: false };
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (value === "--help" || value === "-h") {
      result.help = true;
      continue;
    }
    if (value === "--theme") {
      const theme = values[index + 1];
      if (!theme) throw new Error("--theme requires a theme name or path");
      result.theme = theme;
      index += 1;
      continue;
    }
    if (value?.startsWith("--theme=")) {
      result.theme = value.slice("--theme=".length);
      continue;
    }
    if (value === "--remote" || value === "--remote-cwd" || value === "--remote-bin") {
      const next = values[index + 1];
      if (!next) throw new Error(`${value} requires a value`);
      if (value === "--remote") result.remote = next;
      else if (value === "--remote-cwd") result.remoteCwd = next;
      else result.remoteBin = next;
      index += 1;
      continue;
    }
    if (value?.startsWith("--remote=")) { result.remote = value.slice("--remote=".length); continue; }
    if (value?.startsWith("--remote-cwd=")) { result.remoteCwd = value.slice("--remote-cwd=".length); continue; }
    if (value?.startsWith("--remote-bin=")) { result.remoteBin = value.slice("--remote-bin=".length); continue; }
    throw new Error(`Unknown argument: ${value}`);
  }
  return result;
}
