import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getCrewCoderHome } from "./crewcoder-home.js";

/**
 * One file a tool call changed, as a unified git diff. `patch` is omitted for
 * binary files and for patches over MAX_FILE_PATCH_BYTES (`truncated`).
 */
export type WorkspaceFileDiff = {
  path: string;
  /** Only created and modified files are reported; deletions are not. */
  status: "added" | "modified";
  additions: number;
  deletions: number;
  binary: boolean;
  truncated: boolean;
  patch?: string;
};

/** A snapshot taken when a tool started; see `WorkspaceDiffTracker.end`. */
export type DiffBaseline = { tree: string; seq: number };

const MAX_FILE_PATCH_BYTES = 64 * 1024;
const MAX_FILES = 50;
const SNAPSHOT_TIMEOUT_MS = 10_000;
const DIFF_MAX_BUFFER = 16 * 1024 * 1024;
/** Heavy or generated directories never snapshotted, on top of the workspace's own .gitignore. */
const DEFAULT_EXCLUDES = ["node_modules/", "dist/", "build/", "coverage/", ".next/", ".turbo/", ".crewcoder/", ".venv/", "target/", "__pycache__/"];

/**
 * Normalized names (lower case, no separators, MCP prefix removed) of the
 * tools that create or modify files: CrewCoder's and the provider-native edit
 * and write tools (Claude, Codex). Shell commands, git primitives, generators,
 * and delegated workers are deliberately not diffed (owner decision).
 */
const FILE_EDIT_TOOLS = new Set([
  "edit", "multiedit", "write", "notebookedit", "strreplace", "createfile", "editsymbol", "edittransaction",
  "codexfilechange", "applypatch"
]);

export function isFileEditTool(toolName: string): boolean {
  const key = toolName.replace(/^mcp__[^_]+(?:_[^_]+)*__/, "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return FILE_EDIT_TOOLS.has(key);
}

export type WorkspaceDiffOptions = {
  /** Where snapshot git directories live; defaults to `<CREWCODER_HOME>/snapshots`. */
  snapshotsDir?: string;
  /** Reports why tracking turned itself off (git missing, too slow, ...). */
  onDisabled?: (reason: string) => void;
};

/**
 * Per-tool file diffs from workspace snapshots, so changes made any way (shell
 * commands, provider-native tools) show up, not only CrewCoder edit tools.
 *
 * Snapshots live in a private git directory under CrewCoder's home with the
 * workspace as its work tree: `git add --all` + `write-tree` against a private
 * index. The user's own repository, index, and history are never read or
 * written, and non-git workspaces work too. The workspace's .gitignore applies,
 * plus DEFAULT_EXCLUDES. Operations are serialized (one index). Any git failure
 * or a snapshot slower than SNAPSHOT_TIMEOUT_MS disables tracking for the run
 * rather than slowing tools down.
 */
export class WorkspaceDiffTracker {
  private readonly cwd: string;
  private readonly options: WorkspaceDiffOptions;
  private gitDir: string | undefined;
  private ready: Promise<boolean> | undefined;
  private disabled = false;
  private queue: Promise<unknown> = Promise.resolve();
  private seq = 0;
  private lastEnd: DiffBaseline | undefined;

  constructor(cwd: string, options: WorkspaceDiffOptions = {}) {
    this.cwd = path.resolve(cwd);
    this.options = options;
  }

  /**
   * Snapshot the workspace as the current baseline (before a model turn), so a
   * provider-native tool that is already running when it is announced still
   * has a baseline from before it started (see `begin({ reuseLast })`).
   */
  prime(): Promise<void> {
    return this.serial(async () => {
      const tree = await this.snapshot();
      if (tree) this.lastEnd = { tree, seq: ++this.seq };
    });
  }

  /**
   * Baseline before a tool runs; await it before running the tool. `reuseLast`
   * takes the latest snapshot instead of a new one, for provider-native tools
   * that may already be writing when they are announced. Undefined when
   * tracking is off or failed.
   */
  begin(options: { reuseLast?: boolean } = {}): Promise<DiffBaseline | undefined> {
    return this.serial(async () => {
      if (options.reuseLast && this.lastEnd) return { tree: this.lastEnd.tree, seq: this.seq };
      const tree = await this.snapshot();
      return tree ? { tree, seq: ++this.seq } : undefined;
    });
  }

  /**
   * Snapshot after the tool and diff it against the most recent of its own
   * baseline and the last finished tool's snapshot, so overlapping (parallel)
   * tools never report the same change twice: a change is credited to the
   * first tool that finishes after it.
   */
  end(baseline: DiffBaseline | undefined): Promise<WorkspaceFileDiff[]> {
    if (!baseline) return Promise.resolve([]);
    return this.serial(async () => {
      const tree = await this.snapshot();
      if (!tree) return [];
      const from = this.lastEnd && this.lastEnd.seq > baseline.seq ? this.lastEnd.tree : baseline.tree;
      this.lastEnd = { tree, seq: ++this.seq };
      return from === tree ? [] : await this.diff(from, tree);
    });
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async snapshot(): Promise<string | undefined> {
    if (this.disabled || !(await this.init())) return undefined;
    try {
      await this.git(["add", "--all", "--ignore-errors", "--", "."], SNAPSHOT_TIMEOUT_MS).catch((error: unknown) => {
        // --ignore-errors still exits non-zero for unreadable files after adding the rest.
        if (!isExitError(error)) throw error;
      });
      return (await this.git(["write-tree"], SNAPSHOT_TIMEOUT_MS)).trim();
    } catch (error) {
      this.disable(`snapshot failed: ${errorText(error)}`);
      return undefined;
    }
  }

  private async diff(from: string, to: string): Promise<WorkspaceFileDiff[]> {
    try {
      const base = ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames"];
      const [names, counts, patch] = await Promise.all([
        this.git([...base, "--name-status", "-z", from, to]),
        this.git([...base, "--numstat", "-z", from, to]),
        this.git([...base, "--unified=3", from, to])
      ]);
      return buildFileDiffs(names, counts, patch);
    } catch (error) {
      this.disable(`diff failed: ${errorText(error)}`);
      return [];
    }
  }

  /** Create the private snapshot repository once. False disables tracking. */
  private init(): Promise<boolean> {
    this.ready ??= (async () => {
      if (this.cwd === path.parse(this.cwd).root || this.cwd === os.homedir()) {
        this.disable("workspace is the filesystem root or home directory");
        return false;
      }
      const root = this.options.snapshotsDir ?? path.join(getCrewCoderHome().root, "snapshots");
      const gitDir = path.join(root, createHash("sha256").update(this.cwd).digest("hex").slice(0, 16));
      try {
        await fs.mkdir(root, { recursive: true, mode: 0o700 });
        this.gitDir = gitDir;
        await fs.access(path.join(gitDir, "HEAD")).catch(async () => {
          await this.git(["init", "--quiet"]);
          await fs.mkdir(path.join(gitDir, "info"), { recursive: true });
          await fs.writeFile(path.join(gitDir, "info", "exclude"), `${DEFAULT_EXCLUDES.join("\n")}\n`, "utf8");
        });
        return true;
      } catch (error) {
        this.disable(`git unavailable: ${errorText(error)}`);
        return false;
      }
    })();
    return this.ready;
  }

  private disable(reason: string): void {
    if (this.disabled) return;
    this.disabled = true;
    this.options.onDisabled?.(reason);
  }

  /** Runs git against the private snapshot repository only; inherited GIT_* variables are dropped. */
  private git(args: string[], timeout = SNAPSHOT_TIMEOUT_MS): Promise<string> {
    const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
    env.GIT_DIR = this.gitDir;
    env.GIT_WORK_TREE = this.cwd;
    env.GIT_TERMINAL_PROMPT = "0";
    const config = ["-c", "core.autocrlf=false", "-c", "core.quotepath=off", "-c", "core.fsmonitor=false", "-c", "core.safecrlf=false", "-c", "advice.addEmbeddedRepo=false", "-c", "gc.auto=0"];
    return new Promise((resolve, reject) => {
      execFile("git", [...config, ...args], { cwd: this.cwd, env, timeout, maxBuffer: DIFF_MAX_BUFFER, encoding: "utf8" }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      });
    });
  }
}

/** Combine `--name-status -z`, `--numstat -z`, and the full patch into per-file diffs. */
export function buildFileDiffs(nameStatus: string, numstat: string, patch: string): WorkspaceFileDiff[] {
  const status = new Map<string, WorkspaceFileDiff["status"] | "deleted">();
  const names = nameStatus.split("\0").filter(Boolean);
  for (let index = 0; index + 1 < names.length; index += 2) {
    const code = names[index]!;
    status.set(names[index + 1]!, code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : "modified");
  }
  const patches = splitPatch(patch);
  const changed = numstat.split("\0").filter(Boolean).filter((line) => status.get(line.split("\t")[2] ?? "") !== "deleted");
  return changed.slice(0, MAX_FILES).map((line) => {
    const [added = "0", deleted = "0", file = ""] = line.split("\t");
    const binary = added === "-";
    const text = patches.get(file);
    const truncated = !binary && text !== undefined && Buffer.byteLength(text) > MAX_FILE_PATCH_BYTES;
    return {
      path: file,
      status: status.get(file) === "added" ? "added" : "modified",
      additions: binary ? 0 : Number(added),
      deletions: binary ? 0 : Number(deleted),
      binary,
      truncated,
      ...(binary || truncated || text === undefined ? {} : { patch: text })
    };
  });
}

/** Split a multi-file `git diff` into one patch per path (the `b/` side, or `a/` for deletions). */
function splitPatch(patch: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const part of patch.split(/^(?=diff --git )/m)) {
    if (!part.startsWith("diff --git ")) continue;
    const plus = /^\+\+\+ b\/(.+)$/m.exec(part)?.[1];
    const minus = /^--- a\/(.+)$/m.exec(part)?.[1];
    const header = /^diff --git a\/(.+) b\/(.+)$/m.exec(part);
    const file = plus ?? minus ?? header?.[2];
    if (file) files.set(file, part);
  }
  return files;
}

/** `git add --ignore-errors` exits 1 when some files could not be read; anything else is a real failure. */
function isExitError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === 1;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message.split("\n", 1)[0] ?? error.message : String(error);
}
