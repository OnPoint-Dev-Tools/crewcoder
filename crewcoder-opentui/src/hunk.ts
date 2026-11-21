import { spawn } from "node:child_process";
import path from "node:path";

/** Result of a program that took over the terminal (see `SessionController.runInTerminal`). */
export type TerminalRunResult = {
  /** Exit code; null when the program was killed by a signal or never started. */
  code: number | null;
  /** The end of what it wrote to stderr, for the error alert. */
  stderr: string;
  /** The executable was not found on PATH. */
  missing: boolean;
};

export type TerminalRun = (command: string, args: readonly string[], cwd: string) => Promise<TerminalRunResult>;

export const HUNK_COMMAND = "hunk";
/** Short lines: alerts clip rather than wrap, and the welcome screen alert is narrow. */
export const HUNK_INSTALL_HINT = "Install: npm install -g hunkdiff\nor: brew install hunk (see hunk.dev)\nThen run /diff again.";
const STDERR_TAIL_CHARS = 2_000;

/**
 * `hunk diff` scoped to the files this session changed, as workspace-relative
 * pathspecs. Hunk compares the git working tree with HEAD, so uncommitted edits
 * the user made to those files show too. With no recorded changes it shows the
 * whole working tree.
 */
export function hunkDiffArgs(changedFiles: readonly string[], cwd: string): string[] {
  const files = [...new Set(changedFiles.map((file) => workspacePath(file, cwd)).filter(Boolean))];
  return files.length ? ["diff", "--", ...files] : ["diff"];
}

function workspacePath(file: string, cwd: string): string {
  if (!path.isAbsolute(file)) return file;
  const relative = path.relative(cwd, file);
  // Outside the workspace: keep the absolute path; git rejects it with a clear message.
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : file;
}

/**
 * Run a full-screen program on the real terminal: stdin and stdout are
 * inherited, stderr is captured (it is replayed in an alert on failure,
 * because the UI repaints over anything printed there).
 */
export function spawnInTerminal(command: string, args: readonly string[], cwd: string): Promise<TerminalRunResult> {
  return new Promise((resolve) => {
    let stderr = "";
    const child = spawn(command, [...args], { cwd, stdio: ["inherit", "inherit", "pipe"] });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS);
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      resolve({ code: null, stderr: error.code === "ENOENT" ? "" : error.message, missing: error.code === "ENOENT" });
    });
    child.once("close", (code) => resolve({ code, stderr, missing: false }));
  });
}
