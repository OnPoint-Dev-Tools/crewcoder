import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { getSessionDir } from "./session-store.js";

export type SessionCheckpoint = {
  id: string;
  createdAt: string;
  cwd: string;
  reason: string;
  toolCallId?: string;
  toolName?: string;
  fileCount: number;
  totalBytes: number;
  truncated: boolean;
  path: string;
};

export type SessionCheckpointDiff = { path: string; lines: string[]; truncated: boolean };

export type SessionCheckpointRestore = {
  checkpointId: string;
  sessionId: string;
  restoredAt: string;
  restoredFiles: number;
  deletedFiles: number;
};

export type SessionCheckpointPreview = {
  checkpoint: SessionCheckpoint;
  restoreFiles: string[];
  deleteFiles: string[];
  unchangedFiles: string[];
  missingFiles: string[];
  changedFiles: string[];
  diffs: SessionCheckpointDiff[];
};

type CheckpointManifest = SessionCheckpoint & {
  files: Array<{ path: string; bytes: number }>;
};

type FileEntry = { path: string; absolutePath: string; bytes: number };

const SNAPSHOT_EXCLUDED_DIRS = new Set([".git", ".crewcoder", "node_modules", "dist", "build", "coverage", ".next", ".turbo"]);
const MAX_FILES = 2_000;
const MAX_BYTES = 25 * 1024 * 1024;
export const MAX_SESSION_CHECKPOINTS = 10;
let lastCheckpointCreatedAtMs = 0;

export async function createSessionCheckpoint(options: { sessionId: string; cwd: string; reason: string; toolCallId?: string; toolName?: string }): Promise<SessionCheckpoint> {
  const createdAt = nextCheckpointCreatedAt();
  const id = `checkpoint_${createdAt.replace(/[:.]/g, "-")}_${Math.random().toString(36).slice(2, 8)}`;
  const checkpointDir = path.join(checkpointsDir(options.sessionId), id);
  const filesDir = path.join(checkpointDir, "files");
  await fs.mkdir(filesDir, { recursive: true });

  const collected = await collectWorkspaceFiles(options.cwd);
  const copied: Array<{ path: string; bytes: number }> = [];
  let totalBytes = 0;
  let truncated = false;
  for (const file of collected) {
    if (copied.length >= MAX_FILES || totalBytes + file.bytes > MAX_BYTES) {
      truncated = true;
      break;
    }
    const target = path.join(filesDir, file.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(file.absolutePath, target);
    copied.push({ path: file.path, bytes: file.bytes });
    totalBytes += file.bytes;
  }

  const checkpoint: SessionCheckpoint = {
    id,
    createdAt,
    cwd: options.cwd,
    reason: options.reason,
    toolCallId: options.toolCallId,
    toolName: options.toolName,
    fileCount: copied.length,
    totalBytes,
    truncated,
    path: checkpointDir
  };
  const manifest: CheckpointManifest = { ...checkpoint, files: copied };
  await fs.writeFile(path.join(checkpointDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  await pruneOldSessionCheckpoints(options.sessionId);
  return checkpoint;
}

export async function listSessionCheckpoints(sessionId: string): Promise<SessionCheckpoint[]> {
  try {
    const entries = await fs.readdir(checkpointsDir(sessionId), { withFileTypes: true });
    const checkpoints: SessionCheckpoint[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const manifest = await readCheckpointManifest(sessionId, entry.name);
        const { files: _files, ...checkpoint } = manifest;
        checkpoints.push(checkpoint);
      } catch {}
    }
    return checkpoints.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  } catch {
    return [];
  }
}

export async function previewSessionCheckpointRestore(sessionId: string, checkpointId: string, options: { cwd?: string } = {}): Promise<SessionCheckpointPreview> {
  const manifest = await readCheckpointManifest(sessionId, checkpointId);
  const cwd = options.cwd ? path.resolve(options.cwd) : manifest.cwd;
  const snapshotPaths = new Set(manifest.files.map((file) => file.path));
  const current = await collectWorkspaceFiles(cwd);
  const currentPaths = new Set(current.map((file) => file.path));
  const deleteFiles = current.filter((file) => !snapshotPaths.has(file.path)).map((file) => file.path);
  const unchangedFiles: string[] = [];
  const missingFiles: string[] = [];
  const changedFiles: string[] = [];
  const diffs: SessionCheckpointDiff[] = [];
  const filesDir = path.join(checkpointsDir(sessionId), checkpointId, "files");
  for (const file of manifest.files) {
    if (!currentPaths.has(file.path)) {
      missingFiles.push(file.path);
      continue;
    }
    const source = path.join(filesDir, file.path);
    const target = path.join(cwd, file.path);
    if (await sameFileContent(source, target)) unchangedFiles.push(file.path);
    else {
      changedFiles.push(file.path);
      const diff = await diffTextFiles(file.path, source, target);
      if (diff) diffs.push(diff);
    }
  }
  const { files: _files, ...checkpoint } = manifest;
  return { checkpoint, restoreFiles: [...missingFiles, ...changedFiles], deleteFiles, unchangedFiles, missingFiles, changedFiles, diffs };
}

export async function restoreSessionCheckpoint(sessionId: string, checkpointId: string, options: { cwd?: string } = {}): Promise<{ restoredFiles: number; deletedFiles: number; checkpoint: SessionCheckpoint }> {
  const manifest = await readCheckpointManifest(sessionId, checkpointId);
  const cwd = options.cwd ? path.resolve(options.cwd) : manifest.cwd;
  const preview = await previewSessionCheckpointRestore(sessionId, checkpointId, { cwd });
  await assertRestorePathsContainNoSymlinks(cwd, [...manifest.files.map((file) => file.path), ...preview.deleteFiles]);
  for (const filePath of preview.deleteFiles) {
    await fs.rm(path.join(cwd, filePath), { force: true });
  }

  const filesDir = path.join(checkpointsDir(sessionId), checkpointId, "files");
  for (const file of manifest.files) {
    const source = path.join(filesDir, file.path);
    const target = path.join(cwd, file.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
  }
  await pruneEmptyDirs(cwd, cwd);
  const { files: _files, ...checkpoint } = manifest;
  return { restoredFiles: manifest.files.length, deletedFiles: preview.deleteFiles.length, checkpoint };
}

async function assertRestorePathsContainNoSymlinks(cwd: string, relativePaths: string[]): Promise<void> {
  const root = path.resolve(cwd);
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(`Checkpoint restore cwd is not a real directory: ${root}`);
  for (const relativePath of relativePaths) {
    let current = root;
    for (const segment of relativePath.split("/")) {
      current = path.join(current, segment);
      try {
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink()) throw new Error(`Checkpoint restore refuses symbolic-link path: ${relativePath}`);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") break;
        throw error;
      }
    }
  }
}

async function pruneOldSessionCheckpoints(sessionId: string): Promise<void> {
  const checkpoints = await listSessionCheckpoints(sessionId);
  const expired = checkpoints.slice(0, Math.max(0, checkpoints.length - MAX_SESSION_CHECKPOINTS));
  await Promise.all(expired.map((checkpoint) => fs.rm(checkpoint.path, { recursive: true, force: true })));
}

function nextCheckpointCreatedAt(): string {
  lastCheckpointCreatedAtMs = Math.max(Date.now(), lastCheckpointCreatedAtMs + 1);
  return new Date(lastCheckpointCreatedAtMs).toISOString();
}

function checkpointsDir(sessionId: string): string {
  return path.join(getSessionDir(sessionId), "checkpoints");
}

async function readCheckpointManifest(sessionId: string, checkpointId: string): Promise<CheckpointManifest> {
  const manifestPath = path.join(checkpointsDir(sessionId), checkpointId, "manifest.json");
  return JSON.parse(await fs.readFile(manifestPath, "utf8")) as CheckpointManifest;
}

async function diffTextFiles(filePath: string, beforePath: string, afterPath: string): Promise<SessionCheckpointDiff | undefined> {
  const [before, after] = await Promise.all([readTextPreview(beforePath), readTextPreview(afterPath)]);
  if (!before || !after) return undefined;
  const beforeLines = before.text.split(/\r?\n/);
  const afterLines = after.text.split(/\r?\n/);
  const lines: string[] = [];
  const max = Math.max(beforeLines.length, afterLines.length);
  let truncated = before.truncated || after.truncated;
  for (let index = 0; index < max; index++) {
    if (beforeLines[index] === afterLines[index]) continue;
    if (lines.length >= 24) { truncated = true; break; }
    const lineNumber = index + 1;
    if (beforeLines[index] !== undefined) lines.push(`-${lineNumber}: ${beforeLines[index]}`);
    if (afterLines[index] !== undefined) lines.push(`+${lineNumber}: ${afterLines[index]}`);
  }
  return lines.length ? { path: filePath, lines, truncated } : undefined;
}

async function readTextPreview(filePath: string): Promise<{ text: string; truncated: boolean } | undefined> {
  const buffer = await fs.readFile(filePath).catch(() => undefined);
  if (!buffer || buffer.includes(0)) return undefined;
  const maxBytes = 64 * 1024;
  const sliced = buffer.byteLength > maxBytes ? buffer.subarray(0, maxBytes) : buffer;
  return { text: sliced.toString("utf8"), truncated: buffer.byteLength > maxBytes };
}

async function sameFileContent(left: string, right: string): Promise<boolean> {
  try {
    const [leftContent, rightContent] = await Promise.all([fs.readFile(left), fs.readFile(right)]);
    return leftContent.equals(rightContent);
  } catch {
    return false;
  }
}

async function collectWorkspaceFiles(cwd: string): Promise<FileEntry[]> {
  const root = path.resolve(cwd);
  const files: FileEntry[] = [];
  await walk(root, root, files);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function walk(root: string, dir: string, files: FileEntry[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const absolutePath = path.join(dir, entry.name);
    const relativePath = toPosix(path.relative(root, absolutePath));
    if (entry.isDirectory()) {
      if (SNAPSHOT_EXCLUDED_DIRS.has(entry.name)) continue;
      await walk(root, absolutePath, files);
      continue;
    }
    if (!entry.isFile()) continue;
    const stat = await fs.stat(absolutePath);
    files.push({ path: relativePath, absolutePath, bytes: stat.size });
  }
}

async function pruneEmptyDirs(root: string, dir: string): Promise<boolean> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return true;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (SNAPSHOT_EXCLUDED_DIRS.has(entry.name)) continue;
    const child = path.join(dir, entry.name);
    if (await pruneEmptyDirs(root, child)) await fs.rmdir(child).catch(() => undefined);
  }
  if (dir === root) return false;
  return (await fs.readdir(dir).catch(() => ["keep"])).length === 0;
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}
