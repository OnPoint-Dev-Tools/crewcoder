export type CrewCoderRemoteConnection = {
  target: string;
  cwd: string;
  binary: string;
};

const DEFAULT_REMOTE_BINARY = "~/crewcoder-runner/crewcoder";

export function readCrewCoderRemoteConnection(env: NodeJS.ProcessEnv = process.env): CrewCoderRemoteConnection | undefined {
  const target = env.CREWCODER_REMOTE?.trim();
  if (!target) return undefined;
  return validateCrewCoderRemoteConnection({
    target,
    cwd: env.CREWCODER_REMOTE_CWD?.trim() || "~",
    binary: env.CREWCODER_REMOTE_BIN?.trim() || DEFAULT_REMOTE_BINARY
  });
}

export function validateCrewCoderRemoteConnection(connection: CrewCoderRemoteConnection): CrewCoderRemoteConnection {
  const target = connection.target.trim();
  const cwd = connection.cwd.trim();
  const binary = connection.binary.trim();
  if (!target || target.startsWith("-") || /[\s\0\r\n]/.test(target)) {
    throw new Error("Remote SSH target must be a host, SSH alias, or user@host without whitespace or leading options.");
  }
  if (!cwd || /[\0\r\n]/.test(cwd)) throw new Error("Remote workspace path is required and cannot contain line breaks.");
  if (!binary || /[\0\r\n]/.test(binary)) throw new Error("Remote CrewCoder binary path is required and cannot contain line breaks.");
  return { target, cwd, binary };
}

export function buildRemoteCrewCoderCommand(connection: CrewCoderRemoteConnection, args: string[]): string {
  const validated = validateCrewCoderRemoteConnection(connection);
  const executable = remotePathToken(validated.binary);
  const commandArgs = args.map(quoteShell).join(" ");
  const taskOverride = normalizedBooleanEnvironment(process.env.CREWCODER_TASKS_ENABLED);
  const exports = [`FORCE_COLOR=0`, ...(taskOverride === undefined ? [] : [`CREWCODER_TASKS_ENABLED=${taskOverride}`])].join(" ");
  return `export ${exports}; cd ${remotePathToken(validated.cwd)} && exec ${executable}${commandArgs ? ` ${commandArgs}` : ""}`;
}

function normalizedBooleanEnvironment(value: string | undefined): "true" | "false" | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "on") return "true";
  if (normalized === "false" || normalized === "0" || normalized === "off") return "false";
  return undefined;
}

function remotePathToken(value: string): string {
  if (value === "~") return '"$HOME"';
  if (value.startsWith("~/")) return `"$HOME"/${quoteShell(value.slice(2))}`;
  return quoteShell(value);
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
