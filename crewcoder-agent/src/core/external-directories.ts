import fs from "node:fs/promises";
import path from "node:path";
import { loadSessionRecord, saveSession, type SessionRecord } from "./session-store.js";

export const MAX_EXTERNAL_DIRECTORIES = 32;

/**
 * Canonicalize an explicit session grant. The filesystem root is refused because
 * granting it would silently collapse CrewCoder's workspace boundary entirely.
 */
export async function validateExternalDirectory(directory: string, cwd: string): Promise<string> {
  const value = directory.trim();
  if (!value) throw new Error("External directory path is required");
  const resolved = path.resolve(cwd, value);
  const canonical = await fs.realpath(resolved).catch(() => {
    throw new Error(`External directory does not exist: ${resolved}`);
  });
  const stat = await fs.stat(canonical);
  if (!stat.isDirectory()) throw new Error(`External directory is not a directory: ${canonical}`);
  if (canonical === path.parse(canonical).root) throw new Error("The filesystem root cannot be added as an external directory");
  return canonical;
}

export function normalizeExternalDirectories(cwd: string, directories: readonly string[] | undefined): string[] {
  const workspace = path.resolve(cwd);
  const unique: string[] = [];
  for (const value of directories ?? []) {
    if (typeof value !== "string" || !value.trim()) continue;
    const resolved = path.resolve(cwd, value);
    if (resolved === workspace || resolved.startsWith(`${workspace}${path.sep}`)) continue;
    if (resolved === path.parse(resolved).root) throw new Error("The filesystem root cannot be added as an external directory");
    if (!unique.includes(resolved)) unique.push(resolved);
  }
  if (unique.length > MAX_EXTERNAL_DIRECTORIES) throw new Error(`A session may grant at most ${MAX_EXTERNAL_DIRECTORIES} external directories`);
  return unique;
}

export async function validateExternalDirectories(cwd: string, directories: readonly string[] | undefined): Promise<string[]> {
  if ((directories?.length ?? 0) > MAX_EXTERNAL_DIRECTORIES) throw new Error(`A session may grant at most ${MAX_EXTERNAL_DIRECTORIES} external directories`);
  const validated: string[] = [];
  for (const directory of directories ?? []) validated.push(await validateExternalDirectory(directory, cwd));
  return normalizeExternalDirectories(cwd, validated);
}

export async function setSessionExternalDirectories(sessionId: string, directories: readonly string[]): Promise<SessionRecord> {
  const record = await loadSessionRecord(sessionId);
  const externalDirectories = await validateExternalDirectories(record.cwd, directories);
  const updated = { ...record, externalDirectories };
  await saveSession(updated);
  return updated;
}

export async function addSessionExternalDirectory(sessionId: string, directory: string): Promise<SessionRecord> {
  const record = await loadSessionRecord(sessionId);
  const added = await validateExternalDirectory(directory, record.cwd);
  return setSessionExternalDirectories(sessionId, [...(record.externalDirectories ?? []), added]);
}

export async function removeSessionExternalDirectory(sessionId: string, directory: string): Promise<SessionRecord> {
  const record = await loadSessionRecord(sessionId);
  const target = path.resolve(record.cwd, directory);
  const externalDirectories = normalizeExternalDirectories(record.cwd, record.externalDirectories)
    .filter((existing) => existing !== target);
  if (externalDirectories.length === (record.externalDirectories ?? []).length) {
    throw new Error(`External directory is not attached to session ${sessionId}: ${target}`);
  }
  const updated = { ...record, externalDirectories };
  await saveSession(updated);
  return updated;
}

export function formatExternalDirectories(directories: readonly string[]): string {
  if (!directories.length) return "";
  return [
    "External directories explicitly granted to this session:",
    ...directories.map((directory) => `- ${directory}`),
    "File tools may access these roots. Relative paths still resolve from the primary workspace; use absolute paths for external files."
  ].join("\n");
}
