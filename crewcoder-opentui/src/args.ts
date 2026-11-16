export type ParsedArgs = { remote?: string; remoteCwd?: string; remoteBin?: string; help: boolean };

export const USAGE = `CrewCoder OpenTUI (preview)

Usage:
  crewcoder-opentui
  crewcoder-opentui --remote <user@host> --remote-cwd <path> [--remote-bin <path>]

Remote agent:
  --remote user@vps         Run the CrewCoder backend through SSH
  --remote-cwd /workspace   Remote project directory (defaults to ~)
  --remote-bin <path>       Remote CrewCoder binary (defaults to ~/crewcoder-runner/crewcoder)

Requires Node.js >=26.4. The legacy UI remains available as crewcoder-tui
(npm i -g @onpoint-dev-tools/crewcoder-tui).
`;

const VALUE_FLAGS = {
  "--remote": "remote",
  "--remote-cwd": "remoteCwd",
  "--remote-bin": "remoteBin"
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

function isValueFlag(flag: string): flag is keyof typeof VALUE_FLAGS {
  return Object.hasOwn(VALUE_FLAGS, flag);
}
