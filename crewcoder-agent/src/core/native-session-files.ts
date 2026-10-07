import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { ensureCrewCoderHome } from "./crewcoder-home.js";

/**
 * Provider-native session files (Claude Code's project JSONL, Codex rollouts) that travel with a session
 * bundle, so Claude and Codex continue their own session on the new machine instead of a replay.
 */
export type NativeSessionProvider = "claude" | "codex" | "codex-cli";

export type NativeSessionEntry = {
  provider: NativeSessionProvider;
  /** The id CrewCoder stores in providerSessionIds for this provider. */
  providerSessionId: string;
  /** Where the file sits under the provider's home; Claude's is placed by workspace instead. */
  relativePath: string;
  bytes: number;
};

export type LocatedNativeSession = NativeSessionEntry & { file: string };

/** A native transcript is text; anything this large is corrupt or hostile. */
export const MAX_NATIVE_SESSION_BYTES = 2 * 1024 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODEX_SESSION_PREFIX = "codex-thread-v1";

const claudeHome = (): string => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
function codexHome(provider: "codex" | "codex-cli"): string {
  // `codex` runs app-server under CrewCoder's own login; `codex-cli` is the user's own Codex CLI.
  return provider === "codex" ? path.join(ensureCrewCoderHome().root, "codex-app-server") : process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

/** Claude Code's project folder name: every character other than a letter or digit becomes `-`. */
export const claudeProjectFolder = (cwd: string): string => path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-");

function codexThreadId(providerSessionId: string): string | undefined {
  const [prefix, , ...rest] = providerSessionId.split(":");
  const threadId = rest.join(":");
  return prefix === CODEX_SESSION_PREFIX && UUID.test(threadId) ? threadId : undefined;
}

const isNativeProvider = (value: string): value is NativeSessionProvider => value === "claude" || value === "codex" || value === "codex-cli";

async function listDir(dir: string): Promise<string[]> {
  return fs.readdir(dir).catch(() => []);
}

async function findClaudeCopies(sessionId: string): Promise<string[]> {
  const projects = path.join(claudeHome(), "projects");
  const found: string[] = [];
  for (const folder of await listDir(projects)) {
    const file = path.join(projects, folder, `${sessionId}.jsonl`);
    if (await fs.lstat(file).then((stat) => stat.isFile(), () => false)) found.push(file);
  }
  return found;
}

/** Rollouts live at sessions/YYYY/MM/DD/rollout-<time>-<thread>.jsonl. */
async function findCodexCopies(home: string, threadId: string): Promise<string[]> {
  const found: string[] = [];
  const sessions = path.join(home, "sessions");
  for (const year of await listDir(sessions)) {
    for (const month of await listDir(path.join(sessions, year))) {
      for (const day of await listDir(path.join(sessions, year, month))) {
        const dir = path.join(sessions, year, month, day);
        for (const name of await listDir(dir)) {
          if (name.startsWith("rollout-") && name.endsWith(`-${threadId}.jsonl`)) found.push(path.join(dir, name));
        }
      }
    }
  }
  return found;
}

/** Native session files on this machine for the ids a CrewCoder session holds. Missing files are skipped. */
export async function locateNativeSessions(providerSessionIds: Record<string, string>): Promise<LocatedNativeSession[]> {
  const located: LocatedNativeSession[] = [];
  for (const [provider, providerSessionId] of Object.entries(providerSessionIds)) {
    if (!isNativeProvider(provider)) continue;
    let file: string | undefined;
    let relativePath: string | undefined;
    if (provider === "claude") {
      if (!UUID.test(providerSessionId)) continue;
      // Claude finds a session by id in any project folder; the newest copy is the live one.
      const copies = await findClaudeCopies(providerSessionId);
      file = await newest(copies);
      relativePath = `${providerSessionId}.jsonl`;
    } else {
      const threadId = codexThreadId(providerSessionId);
      if (!threadId) continue;
      const home = codexHome(provider);
      file = await newest(await findCodexCopies(home, threadId));
      relativePath = file ? path.relative(home, file).split(path.sep).join("/") : undefined;
    }
    if (!file || !relativePath) continue;
    const bytes = await stableSize(file);
    if (bytes === undefined || bytes > MAX_NATIVE_SESSION_BYTES) continue;
    located.push({ provider, providerSessionId, relativePath, bytes, file });
  }
  return located;
}

async function newest(files: string[]): Promise<string | undefined> {
  let best: { file: string; mtime: number } | undefined;
  for (const file of files) {
    const mtime = (await fs.stat(file)).mtimeMs;
    if (!best || mtime > best.mtime) best = { file, mtime };
  }
  return best?.file;
}

/**
 * A size that ends on a complete line, so a copy taken while the CLI appends is still a valid JSONL prefix.
 * Undefined when the file keeps ending mid-line.
 */
export async function stableSize(file: string): Promise<number | undefined> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { size } = await fs.stat(file);
    if (size === 0) return 0;
    const handle = await fs.open(file, "r");
    try {
      const last = Buffer.alloc(1);
      await handle.read(last, 0, 1, size - 1);
      if (last[0] === 0x0a) return size;
    } finally {
      await handle.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return undefined;
}

/** Validates an entry from another machine; it names files on this one, so nothing in it is trusted. */
export function parseNativeSessionEntry(value: unknown): NativeSessionEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as Partial<NativeSessionEntry>;
  if (typeof entry.provider !== "string" || !isNativeProvider(entry.provider)) return undefined;
  if (typeof entry.providerSessionId !== "string" || typeof entry.relativePath !== "string") return undefined;
  if (typeof entry.bytes !== "number" || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > MAX_NATIVE_SESSION_BYTES) return undefined;
  if (entry.provider === "claude") {
    if (!UUID.test(entry.providerSessionId) || entry.relativePath !== `${entry.providerSessionId}.jsonl`) return undefined;
  } else {
    const threadId = codexThreadId(entry.providerSessionId);
    const pattern = /^sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-[A-Za-z0-9_.-]+\.jsonl$/;
    if (!threadId || !pattern.test(entry.relativePath) || !entry.relativePath.endsWith(`-${threadId}.jsonl`) || entry.relativePath.includes("..")) return undefined;
  }
  return { provider: entry.provider, providerSessionId: entry.providerSessionId, relativePath: entry.relativePath, bytes: entry.bytes };
}

export type PlacedNativeSession = { provider: NativeSessionProvider; file: string; backups: string[] };

/**
 * Puts a native session file where its CLI looks, from bytes [start, start+bytes) of `source`.
 * Existing copies of the same session are moved to backups first, never overwritten or deleted.
 */
export async function placeNativeSession(entry: NativeSessionEntry, source: string, start: number, cwd: string): Promise<PlacedNativeSession> {
  let target: string;
  let existing: string[];
  if (entry.provider === "claude") {
    target = path.join(claudeHome(), "projects", claudeProjectFolder(cwd), entry.relativePath);
    existing = await findClaudeCopies(entry.providerSessionId);
  } else {
    const home = codexHome(entry.provider);
    target = path.join(home, ...entry.relativePath.split("/"));
    existing = await findCodexCopies(home, codexThreadId(entry.providerSessionId)!);
  }
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = path.join(path.dirname(target), `.crewcoder-import-${randomBytes(6).toString("hex")}`);
  try {
    if (entry.bytes > 0) {
      await pipeline(createReadStream(source, { start, end: start + entry.bytes - 1 }), createWriteStream(temp, { flags: "wx", mode: 0o600 }));
    } else {
      await fs.writeFile(temp, "", { flag: "wx", mode: 0o600 });
    }
    // Two copies with one id would leave the CLI to pick one; keep only the moved copy live.
    const backups: string[] = [];
    const backupDir = path.join(ensureCrewCoderHome().root, "backups", "native", entry.provider, new Date().toISOString().replace(/[:.]/g, "-"));
    for (const [index, file] of existing.entries()) {
      await fs.mkdir(backupDir, { recursive: true, mode: 0o700 });
      const backup = path.join(backupDir, `${index}-${path.basename(file)}`);
      await moveFile(file, backup);
      backups.push(backup);
    }
    await fs.rename(temp, target);
    return { provider: entry.provider, file: target, backups };
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}

/** Backups go to CrewCoder's home, which may sit on another disk than ~/.claude or ~/.codex. */
async function moveFile(from: string, to: string): Promise<void> {
  try {
    await fs.rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await fs.copyFile(from, to, fs.constants.COPYFILE_EXCL);
    await fs.unlink(from);
  }
}
