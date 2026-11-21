import {
  branchCrewCoderSession,
  execCrewCoderCommand,
  listCrewCoderProviders,
  listCrewCoderSessions,
  type ProviderRecord,
  type SessionRecord
} from "@onpoint-dev-tools/crewcoder-tui-core/bridge/crewcoder-process";

export type CliResult = { stdout: string; stderr: string; exitCode: number };

/**
 * One-shot CrewCoder CLI calls the pickers need. The shared core resolves
 * local vs. remote (SSH) invocation, so every call here is remote-safe.
 */
export type CrewCoderCli = {
  exec(args: string[]): Promise<CliResult>;
  providers(): Promise<ProviderRecord[]>;
  sessions(): Promise<SessionRecord[]>;
  /** Fork a saved session; resolves to the new session id. */
  branch(sessionId: string): Promise<string>;
};

export const processCli: CrewCoderCli = {
  exec: execCrewCoderCommand,
  providers: listCrewCoderProviders,
  sessions: listCrewCoderSessions,
  branch: branchCrewCoderSession
};

export type WorkerSummary = { name: string; active: boolean; ownerName: string | null };
export type NamedEntry = { name: string; description?: string; path?: string };
export type LoadedSkill = { name: string; description: string; body: string };
export type LoadedPromptCommand = { content: string; missingArguments?: string[] };
export type RewindPreview = { restoreFiles: string[]; deleteFiles: string[] };
export type RewindResult = { restoredFiles: number; deletedFiles: number };

/** Run a command and return stdout, or throw with the CLI's own error text. */
export async function cliText(cli: CrewCoderCli, args: string[]): Promise<string> {
  const { stdout, stderr, exitCode } = await cli.exec(args);
  if (exitCode !== 0) throw new Error(stderr.trim() || `crewcoder ${args.slice(0, 2).join(" ")} exited with code ${exitCode}`);
  return stdout;
}

export async function cliJson<T>(cli: CrewCoderCli, args: string[], fallback: T): Promise<T> {
  const stdout = await cliText(cli, args);
  return stdout.trim() ? JSON.parse(stdout) as T : fallback;
}

export async function readToolMode(cli: CrewCoderCli): Promise<"native" | "crewcoder"> {
  const config = await cliJson<Record<string, unknown>>(cli, ["config", "show"], {});
  return config.toolMode === "crewcoder" ? "crewcoder" : "native";
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
