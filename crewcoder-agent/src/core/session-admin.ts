import fs from "node:fs/promises";
import path from "node:path";
import { branchSession } from "./session-branch.js";
import { loadSession } from "./session-loader.js";
import { getSessionDir, listAllSessions, listSessionHeaders, listSessions, type SessionRecord } from "./session-store.js";

export type SessionListOptions = {
  /** Restrict results to this exact resolved workspace. Omit to list every session. */
  cwd?: string;
  /**
   * Include `messageCount`, the only summary field not present in the session
   * header. It requires fully parsing every session file, so it is opt-in:
   * listings pay a header-only read unless a caller actually needs the count.
   */
  includeMessageCount?: boolean;
};

export type SessionSummary = {
  id: string;
  startedAt: string;
  cwd: string;
  requestedMode: string;
  resolvedMode: string;
  prompt: string;
  /** Provider/model/effort of the session's most recent run; the TUI restores these on resume. */
  provider?: string;
  model?: string;
  effort?: string;
  parentSessionId?: string;
  /** Session-scoped workspace grants; the TUI restores these when resuming. */
  externalDirectories?: string[];
  /** Present only when the caller passed `includeMessageCount`; see SessionListOptions. */
  messageCount?: number;
  loadError?: string;
};

export function assertSessionId(sessionId: string): string {
  const value = sessionId.trim();
  if (!value || value === "." || value === ".." || path.basename(value) !== value || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Session id must contain only letters, numbers, underscores, and hyphens.");
  }
  return value;
}

export async function listSessionSummaries(options: SessionListOptions = {}): Promise<SessionSummary[]> {
  const projectCwd = options.cwd === undefined ? undefined : path.resolve(options.cwd);
  if (!options.includeMessageCount) {
    const headers = await listSessionHeaders(projectCwd);
    return headers.map(toSessionSummary);
  }
  const records = projectCwd === undefined ? await listAllSessions() : await listSessions(projectCwd);
  return records.map((record) => ({ ...toSessionSummary(record), messageCount: record.messages.length }));
}

export async function getSessionRecord(sessionId: string): Promise<SessionRecord> {
  return loadSession(assertSessionId(sessionId));
}

export async function createSessionBranch(sessionId: string): Promise<SessionRecord> {
  return branchSession(assertSessionId(sessionId));
}

export async function deleteSessionRecord(sessionId: string): Promise<boolean> {
  const id = assertSessionId(sessionId);
  const directory = getSessionDir(id);
  try {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Session path is not a real directory: ${id}`);
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
  await fs.rm(directory, { recursive: true, force: false });
  return true;
}

function toSessionSummary(record: SessionRecord): SessionSummary {
  return {
    id: record.id,
    startedAt: record.startedAt,
    cwd: record.cwd,
    requestedMode: record.requestedMode,
    resolvedMode: record.resolvedMode,
    prompt: record.prompt,
    provider: record.provider,
    model: record.model,
    effort: record.effort,
    parentSessionId: record.parentSessionId,
    externalDirectories: record.externalDirectories,
    // messageCount is added only by the includeMessageCount path. Deriving it from
    // a header record would report a confident 0 instead of an honest "not loaded".
    loadError: record.loadError
  };
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
