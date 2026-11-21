export type ParsedArgs = { theme?: string; remote?: string; remoteCwd?: string; remoteBin?: string; crewFile?: string; help: boolean };

export const USAGE = `CrewCoder OpenTUI (preview)

Usage:
  crewcoder-opentui [--theme <name|path>]
  crewcoder-opentui --remote <user@host> --remote-cwd <path> [--remote-bin <path>]

Theme:
  --theme slate|dark|light  Built-in theme (default slate; dark is Gotham)
  --theme <name|path>       Custom JSON theme: a file path, or
                            $CREWCODER_HOME/themes/<name>.json

Remote agent:
  --remote user@vps         Run the CrewCoder backend through SSH
  --remote-cwd /workspace   Remote project directory (defaults to ~)
  --remote-bin <path>       Remote CrewCoder binary (defaults to ~/crewcoder-runner/crewcoder)

Internal:
  --crew-file <path>        Start the crew in a handoff file (written by /crew and /team
                            when you pick "Run in tmux"); the file is read and deleted

Environment:
  CREWCODER_THEME=<name>    Theme when --theme is not given (else the /theme pick, else slate)
  CREWCODER_TUI_MOUSE=0     Leave the mouse to the terminal (native selection;
                            no click toggles, wheel scrolling depends on the terminal)
  CREWCODER_TUI_ICONS=text  Single-cell icons (or emoji; default picks per terminal)
  CREWCODER_TUI_TMUX_HINT=0 Hide the startup note about missing tmux settings

Requires Node.js >=26.4. The legacy UI remains available as crewcoder-tui
(npm i -g @onpoint-dev-tools/crewcoder-tui).
`;

const VALUE_FLAGS = {
  "--theme": "theme",
  "--remote": "remote",
  "--remote-cwd": "remoteCwd",
  "--remote-bin": "remoteBin",
  "--crew-file": "crewFile"
} as const satisfies Record<string, keyof ParsedArgs>;

export function parseArgs(values: readonly string[]): ParsedArgs {
  const result: ParsedArgs = { help: false };
  for (let index = 0; index < values.length; index++) {
    const value = values[index] ?? "";
    if (value === "--help" || value === "-h") {
      result.help = true;
      continue;
    }
    const [flag, inline] = value.includes("=") ? [value.slice(0, value.indexOf("=")), value.slice(value.indexOf("=") + 1)] : [value, undefined];
    if (!isValueFlag(flag)) throw new Error(`Unknown argument: ${value}`);
    const next = inline ?? values[++index];
    if (!next) throw new Error(`${flag} requires a value`);
    result[VALUE_FLAGS[flag]] = next;
  }
  return result;
}

/** Mouse reporting stays on unless `CREWCODER_TUI_MOUSE=0`, the same switch as the legacy UI. */
export function mouseEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CREWCODER_TUI_MOUSE !== "0";
}

function isValueFlag(flag: string): flag is keyof typeof VALUE_FLAGS {
  return Object.hasOwn(VALUE_FLAGS, flag);
}
