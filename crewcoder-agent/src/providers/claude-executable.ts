import fs from "node:fs";
import path from "node:path";

/** Prefer the user's current Claude Code; undefined lets the SDK use its bundled executable. */
export function resolveClaudeExecutable(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.CREWCODER_CLAUDE_PATH) return env.CREWCODER_CLAUDE_PATH;
  const names = process.platform === "win32" ? ["claude.exe", "claude"] : ["claude"];
  for (const directory of (env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    for (const name of names) {
      const candidate = path.resolve(directory, name);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        fs.accessSync(candidate, fs.constants.X_OK);
        return fs.realpathSync(candidate);
      } catch {
        // Keep scanning PATH; an explicit override is intentionally never replaced.
      }
    }
  }
  return undefined;
}
