/**
 * Session store pruning.
 *
 * The session store grows without bound: checkpoints retain 10 full snapshots per
 * session, and older bloat-repair paths could leave large `.bak` files behind. This
 * module reports what could be reclaimed and, only when explicitly told to, removes it.
 *
 * Two deliberate safety properties:
 *
 * - **Dry run by default.** `apply` must be set. There is no interactive prompt, so
 *   the same command works in CI, but nothing is destroyed without an explicit flag.
 * - **Age comes from the session header, not mtime.** A session file is rewritten on
 *   every save, so mtime reports when it was last *touched*, not how old the work is.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getSessionsDir, listSessionHeaders } from "./session-store.js";

/**
 * Files that are the session itself and are never treated as disposable artifacts.
 * `runtime.json` is small but not regenerable: deleting it silently resets the
 * session's last-used provider/model/effort back to whatever it started on.
 */
const SESSION_FILES = new Set(["session.jsonl", "session.json", "runtime.json"]);
const CHECKPOINTS_DIR = "checkpoints";

export type SessionPruneKind = "artifact" | "checkpoints" | "session";

export type SessionPruneTarget = {
  kind: SessionPruneKind;
  sessionId: string;
  /** Absolute path that would be removed. */
  path: string;
  bytes: number;
  reason: string;
};

export type SessionPrunePlan = {
  targets: SessionPruneTarget[];
  totalBytes: number;
  sessionsScanned: number;
  /** True when the targets were actually removed. */
  applied: boolean;
  /** Targets that failed to delete, with the reason. Never aborts the rest. */
  failures: Array<{ path: string; error: string }>;
};

export type SessionPruneOptions = {
  /** Leftover files in a session directory that are not the session or its checkpoints. */
  artifacts?: boolean;
  /** Checkpoint snapshots for sessions older than `olderThanDays`. */
  checkpoints?: boolean;
  /** Whole session directories older than `olderThanDays`. */
  sessions?: boolean;
  olderThanDays?: number;
  /** Session ids to leave untouched regardless of age. */
  keep?: string[];
  apply?: boolean;
};

export async function planSessionPrune(options: SessionPruneOptions = {}): Promise<SessionPrunePlan> {
  // Default to the one category that is unambiguously safe: nothing here is
  // reachable by any code path, so removing it cannot change behavior.
  const artifacts = options.artifacts ?? !(options.checkpoints || options.sessions);
  const ageRequired = Boolean(options.checkpoints || options.sessions);
  if (ageRequired && !(typeof options.olderThanDays === "number" && options.olderThanDays > 0)) {
    throw new Error("--older-than <days> is required when pruning checkpoints or sessions.");
  }

  const sessionsDir = getSessionsDir();
  const keep = new Set(options.keep ?? []);
  const cutoff = typeof options.olderThanDays === "number" ? Date.now() - options.olderThanDays * 86_400_000 : undefined;
  const headers = await listSessionHeaders();
  const startedAtById = new Map(headers.map((header) => [header.id, header.startedAt]));

  const entries = await fs.readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
  const targets: SessionPruneTarget[] = [];
  let sessionsScanned = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    sessionsScanned++;
    const sessionId = entry.name;
    if (keep.has(sessionId)) continue;
    const sessionDir = path.join(sessionsDir, sessionId);
    const age = await sessionAgeMs(sessionDir, startedAtById.get(sessionId));
    const olderThanCutoff = cutoff !== undefined && age !== undefined && age < cutoff;

    if (options.sessions && olderThanCutoff) {
      targets.push({
        kind: "session",
        sessionId,
        path: sessionDir,
        bytes: await directorySize(sessionDir),
        reason: `session started ${formatAge(age)} ago`
      });
      // The whole directory goes; no need to also list its parts.
      continue;
    }

    if (artifacts) {
      for (const child of await fs.readdir(sessionDir, { withFileTypes: true }).catch(() => [])) {
        if (child.isDirectory() || SESSION_FILES.has(child.name)) continue;
        const file = path.join(sessionDir, child.name);
        targets.push({
          kind: "artifact",
          sessionId,
          path: file,
          bytes: await fileSize(file),
          reason: "leftover file, not the session or its checkpoints"
        });
      }
    }

    if (options.checkpoints && olderThanCutoff) {
      const checkpointsPath = path.join(sessionDir, CHECKPOINTS_DIR);
      const bytes = await directorySize(checkpointsPath);
      if (bytes > 0) {
        targets.push({
          kind: "checkpoints",
          sessionId,
          path: checkpointsPath,
          bytes,
          reason: `checkpoints for a session started ${formatAge(age)} ago`
        });
      }
    }
  }

  targets.sort((a, b) => b.bytes - a.bytes);
  const plan: SessionPrunePlan = {
    targets,
    totalBytes: targets.reduce((sum, target) => sum + target.bytes, 0),
    sessionsScanned,
    applied: false,
    failures: []
  };
  if (!options.apply) return plan;
  return applySessionPrune(plan, sessionsDir);
}

async function applySessionPrune(plan: SessionPrunePlan, sessionsDir: string): Promise<SessionPrunePlan> {
  const root = path.resolve(sessionsDir);
  const failures: SessionPrunePlan["failures"] = [];

  for (const target of plan.targets) {
    const resolved = path.resolve(target.path);
    // Containment is re-checked at delete time, not just at plan time: the plan is a
    // plain object a caller could have altered between planning and applying.
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
      failures.push({ path: target.path, error: "refusing to delete outside the sessions directory" });
      continue;
    }
    if (resolved === root) {
      failures.push({ path: target.path, error: "refusing to delete the sessions directory itself" });
      continue;
    }
    try {
      const stat = await fs.lstat(resolved);
      if (stat.isSymbolicLink()) {
        failures.push({ path: target.path, error: "refusing to follow a symlink" });
        continue;
      }
      await fs.rm(resolved, { recursive: stat.isDirectory(), force: false });
    } catch (error) {
      failures.push({ path: target.path, error: error instanceof Error ? error.message : String(error) });
    }
  }

  const removed = plan.targets.filter((target) => !failures.some((failure) => failure.path === target.path));
  return {
    ...plan,
    targets: removed,
    totalBytes: removed.reduce((sum, target) => sum + target.bytes, 0),
    applied: true,
    failures
  };
}

/** Header `startedAt` when available, else directory mtime as a last resort. */
async function sessionAgeMs(sessionDir: string, startedAt: string | undefined): Promise<number | undefined> {
  if (startedAt) {
    const parsed = Date.parse(startedAt);
    if (Number.isFinite(parsed)) return parsed;
  }
  const stat = await fs.stat(sessionDir).catch(() => undefined);
  return stat?.mtimeMs;
}

async function fileSize(file: string): Promise<number> {
  const stat = await fs.stat(file).catch(() => undefined);
  return stat?.isFile() ? stat.size : 0;
}

async function directorySize(dir: string): Promise<number> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => undefined);
  if (!entries) return 0;
  let total = 0;
  for (const entry of entries) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await directorySize(child);
    else if (entry.isFile()) total += await fileSize(child);
  }
  return total;
}

export function formatPruneBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatAge(startedAtMs: number | undefined): string {
  if (startedAtMs === undefined) return "an unknown time";
  const days = Math.floor((Date.now() - startedAtMs) / 86_400_000);
  return days < 1 ? "less than a day" : `${days} day${days === 1 ? "" : "s"}`;
}
