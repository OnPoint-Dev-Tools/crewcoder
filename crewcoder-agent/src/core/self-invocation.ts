import path from "node:path";

export type SelfInvocation = {
  command: string;
  args: string[];
};

type ProcessRuntime = Pick<NodeJS.Process, "argv" | "execArgv" | "execPath" | "versions">;

/**
 * Build an argv that starts this CrewCoder CLI again.
 *
 * Node runs the emitted CLI as `node dist/cli.js`, while a Bun-compiled binary
 * embeds its entry under `/$bunfs` and must execute the native binary directly.
 */
export function createSelfInvocation(args: string[], runtime: ProcessRuntime = process): SelfInvocation {
  const entry = runtime.argv[1];
  if (isStandaloneExecutable(runtime)) return { command: runtime.execPath, args };
  if (!entry) throw new Error("Cannot locate the CrewCoder CLI entrypoint.");
  return { command: runtime.execPath, args: [...runtime.execArgv, entry, ...args] };
}

export function isStandaloneExecutable(runtime: ProcessRuntime = process): boolean {
  const entry = runtime.argv[1];
  if (!entry) return Boolean(runtime.argv[0]) && path.resolve(runtime.argv[0]!) === path.resolve(runtime.execPath);
  if (runtime.versions.bun && entry.startsWith("/$bunfs/")) return true;
  return path.resolve(entry) === path.resolve(runtime.execPath);
}
