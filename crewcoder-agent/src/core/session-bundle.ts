import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { ensureCrewCoderHome } from "./crewcoder-home.js";
import { locateNativeSessions, parseNativeSessionEntry, placeNativeSession, stableSize, type NativeSessionEntry, type NativeSessionProvider } from "./native-session-files.js";
import { getSessionDir, readSessionJsonlFile, saveSession, sessionFilePath, sessionRuntimeFilePath, whenSessionWritesSettle } from "./session-store.js";
import { CREWCODER_VERSION } from "./version.js";

/**
 * A portable copy of one durable session, so another machine can continue it with the same context.
 * The file is gzip: one header line, then the session JSONL exactly as stored, then (version 2) each
 * provider-native session file named in the header, back to back.
 */
export const SESSION_BUNDLE_FORMAT = "crewcoder-session-bundle";
export const SESSION_BUNDLE_VERSION = 2;
/** Decompression cap; a bundle is a transcript, so anything larger is corrupt or hostile. */
const MAX_BUNDLE_SESSION_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/;

export type SessionBundleHeader = {
  format: typeof SESSION_BUNDLE_FORMAT;
  /** Version 1 bundles carry only the CrewCoder session. */
  version: 1 | 2;
  sessionId: string;
  exportedAt: string;
  sourceCwd: string;
  sourceHost: string;
  crewcoderVersion: string;
  runtime?: { provider?: string; model?: string; effort?: string };
  /** Version 2: byte length of the session JSONL, so the native files after it can be split off. */
  sessionBytes?: number;
  native?: NativeSessionEntry[];
};

export type SessionBundleExport = { sessionId: string; file: string; bytes: number; native: NativeSessionProvider[] };

export type SessionBundleImport = {
  sessionId: string;
  messages: number;
  /** True when an existing session with this id was moved to backups first. */
  replaced: boolean;
  backupPath?: string;
  /** Providers whose own session was placed, so they continue natively instead of replaying. */
  native: NativeSessionProvider[];
};

export class SessionBundleError extends Error {
  constructor(readonly code: "SESSION_EXISTS" | "INVALID_BUNDLE" | "SESSION_NOT_FOUND", message: string) {
    super(message);
    this.name = "SessionBundleError";
  }
}

/** Ids name a directory under the sessions folder, so one from another machine must not be a path. */
function requireSessionId(id: unknown): string {
  if (typeof id !== "string" || !SESSION_ID.test(id) || id.includes("..")) throw new SessionBundleError("INVALID_BUNDLE", "The bundle names an invalid session id");
  return id;
}

async function readRuntime(sessionId: string): Promise<SessionBundleHeader["runtime"]> {
  try {
    const parsed = JSON.parse(await fs.readFile(sessionRuntimeFilePath(sessionId), "utf8")) as Record<string, unknown>;
    const pick = (key: string) => (typeof parsed[key] === "string" ? (parsed[key] as string) : undefined);
    return { provider: pick("provider"), model: pick("model"), effort: pick("effort") };
  } catch {
    return undefined;
  }
}

export async function exportSessionBundle(sessionId: string, outFile: string): Promise<SessionBundleExport> {
  requireSessionId(sessionId);
  ensureCrewCoderHome();
  // A half-written last line would make the copy unreadable on the other machine.
  await whenSessionWritesSettle();
  const source = sessionFilePath(sessionId);
  const record = await readSessionJsonlFile(source).catch(() => {
    throw new SessionBundleError("SESSION_NOT_FOUND", `Session ${sessionId} was not found in this CrewCoder home`);
  });
  const sessionBytes = await stableSize(source);
  if (sessionBytes === undefined) throw new Error(`Session ${sessionId} is being written; pause it and try again`);
  const native = await locateNativeSessions(record.providerSessionIds ?? {});
  const header: SessionBundleHeader = {
    format: SESSION_BUNDLE_FORMAT,
    version: SESSION_BUNDLE_VERSION,
    sessionId,
    exportedAt: new Date().toISOString(),
    sourceCwd: record.cwd,
    sourceHost: os.hostname(),
    crewcoderVersion: CREWCODER_VERSION,
    runtime: await readRuntime(sessionId),
    sessionBytes,
    native: native.map(({ file: _file, ...entry }) => entry)
  };
  const file = path.resolve(outFile);
  await fs.mkdir(path.dirname(file), { recursive: true });
  async function* body() {
    yield Buffer.from(`${JSON.stringify(header)}\n`);
    // Exact byte ranges, so lines appended while copying cannot shift the native files after them.
    if (sessionBytes) yield* createReadStream(source, { start: 0, end: sessionBytes - 1 });
    for (const entry of native) if (entry.bytes) yield* createReadStream(entry.file, { start: 0, end: entry.bytes - 1 });
  }
  try {
    // `wx`: never overwrite whatever already sits at the destination path.
    await pipeline(Readable.from(body()), createGzip(), createWriteStream(file, { flags: "wx", mode: 0o600 }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") await fs.rm(file, { force: true }).catch(() => undefined);
    throw error;
  }
  return { sessionId, file, bytes: (await fs.stat(file)).size, native: native.map((entry) => entry.provider) };
}

/** Splits the header line off the decompressed stream and passes the session JSONL through, with a size cap. */
class BundleSplitter extends Transform {
  header: SessionBundleHeader | undefined;
  #pending = Buffer.alloc(0);
  #bytes = 0;

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.#bytes += chunk.length;
    if (this.#bytes > MAX_BUNDLE_SESSION_BYTES) return callback(new SessionBundleError("INVALID_BUNDLE", "The bundle is larger than any CrewCoder session can be"));
    if (this.header) return callback(null, chunk);
    this.#pending = Buffer.concat([this.#pending, chunk]);
    const newline = this.#pending.indexOf(0x0a);
    if (newline < 0) {
      return this.#pending.length > MAX_HEADER_BYTES ? callback(new SessionBundleError("INVALID_BUNDLE", "The bundle header is missing")) : callback();
    }
    try {
      this.header = parseHeader(this.#pending.subarray(0, newline).toString("utf8"));
    } catch (error) {
      return callback(error as Error);
    }
    const rest = this.#pending.subarray(newline + 1);
    this.#pending = Buffer.alloc(0);
    callback(null, rest);
  }
}

/**
 * Points the session's own header at the workspace on this machine, so project-filtered listings find it.
 * Safe because the file is still a private temp copy; live session headers are never rewritten.
 */
class SessionCwdRewriter extends Transform {
  #done: boolean;
  #pending = Buffer.alloc(0);

  constructor(private readonly cwd: string | undefined) { super(); this.#done = cwd === undefined; }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    if (this.#done) return callback(null, chunk);
    this.#pending = Buffer.concat([this.#pending, chunk]);
    const newline = this.#pending.indexOf(0x0a);
    if (newline < 0) return this.#pending.length > MAX_HEADER_BYTES * 16 ? this.#release(callback) : callback();
    let first = this.#pending.subarray(0, newline);
    try {
      const entry = JSON.parse(first.toString("utf8")) as { type?: unknown; cwd?: unknown };
      if (entry.type === "session") first = Buffer.from(JSON.stringify({ ...entry, cwd: this.cwd }), "utf8");
    } catch {
      // Left as is; the record read that follows reports a damaged session.
    }
    const rest = this.#pending.subarray(newline);
    this.#done = true;
    this.#pending = Buffer.alloc(0);
    callback(null, Buffer.concat([first, rest]));
  }

  override _flush(callback: TransformCallback): void { this.#release(callback); }

  #release(callback: TransformCallback): void {
    const pending = this.#pending;
    this.#done = true;
    this.#pending = Buffer.alloc(0);
    callback(null, pending.length ? pending : undefined);
  }
}

function parseHeader(line: string): SessionBundleHeader {
  let value: Partial<SessionBundleHeader>;
  try { value = JSON.parse(line) as Partial<SessionBundleHeader>; } catch { throw new SessionBundleError("INVALID_BUNDLE", "The bundle header is not valid JSON"); }
  if (value.format !== SESSION_BUNDLE_FORMAT) throw new SessionBundleError("INVALID_BUNDLE", "This file is not a CrewCoder session bundle");
  if (value.version !== 1 && value.version !== 2) throw new SessionBundleError("INVALID_BUNDLE", `Unsupported session bundle version ${String(value.version)}; update CrewCoder on this machine`);
  let native: NativeSessionEntry[] | undefined;
  if (value.version === 2) {
    if (typeof value.sessionBytes !== "number" || !Number.isSafeInteger(value.sessionBytes) || value.sessionBytes < 0) throw new SessionBundleError("INVALID_BUNDLE", "The bundle header has no session length");
    if (!Array.isArray(value.native) || value.native.length > 3) throw new SessionBundleError("INVALID_BUNDLE", "The bundle header lists invalid native sessions");
    native = value.native.map((item) => {
      const entry = parseNativeSessionEntry(item);
      if (!entry) throw new SessionBundleError("INVALID_BUNDLE", "The bundle header lists an invalid native session");
      return entry;
    });
    if (new Set(native.map((entry) => entry.provider)).size !== native.length) throw new SessionBundleError("INVALID_BUNDLE", "The bundle lists a provider twice");
  }
  return {
    format: SESSION_BUNDLE_FORMAT,
    version: value.version,
    sessionId: requireSessionId(value.sessionId),
    exportedAt: typeof value.exportedAt === "string" ? value.exportedAt : "",
    sourceCwd: typeof value.sourceCwd === "string" ? value.sourceCwd : "",
    sourceHost: typeof value.sourceHost === "string" ? value.sourceHost.slice(0, 200) : "",
    crewcoderVersion: typeof value.crewcoderVersion === "string" ? value.crewcoderVersion : "",
    runtime: value.runtime && typeof value.runtime === "object" ? value.runtime : undefined,
    ...(value.version === 2 ? { sessionBytes: value.sessionBytes as number, native } : {})
  };
}

/** One-time note for the next prompted turn; the agent loop delivers it once and the save clears it. */
export function movedSessionNote(header: SessionBundleHeader, cwd: string | undefined, nativeContinues = false): string {
  const from = header.sourceHost ? ` on ${header.sourceHost}` : "";
  const lines = [nativeContinues
    ? `This session was moved here from another machine${from} and continues with its full history.`
    : `This session was moved here from another machine${from}. Its provider-native sessions stayed behind, so your context is this transcript.`];
  if (cwd && header.sourceCwd && path.resolve(cwd) !== path.resolve(header.sourceCwd)) {
    lines.push(`The workspace was at ${header.sourceCwd} and is now at ${cwd}. Earlier tool results name the old location; use ${cwd} from now on.`);
  }
  return lines.join("\n");
}

export async function importSessionBundle(bundleFile: string, options: { cwd?: string; replace?: boolean } = {}): Promise<SessionBundleImport> {
  const home = ensureCrewCoderHome();
  const token = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const payload = path.join(home.sessionsDir, `.import-${token}.payload`);
  const temp = path.join(home.sessionsDir, `.import-${token}.jsonl`);
  const splitter = new BundleSplitter();
  const cwd = options.cwd ? path.resolve(options.cwd) : undefined;
  try {
    await pipeline(createReadStream(path.resolve(bundleFile)), createGunzip(), splitter, createWriteStream(payload, { flags: "wx", mode: 0o600 })).catch(invalidBundle);
    const header = splitter.header;
    if (!header) throw new SessionBundleError("INVALID_BUNDLE", "The bundle header is missing");
    const payloadBytes = (await fs.stat(payload)).size;
    const sessionBytes = header.sessionBytes ?? payloadBytes;
    const native = header.native ?? [];
    if (sessionBytes + native.reduce((sum, entry) => sum + entry.bytes, 0) !== payloadBytes) {
      throw new SessionBundleError("INVALID_BUNDLE", "The bundle is truncated or its lengths do not match");
    }
    const sessionSource = sessionBytes ? createReadStream(payload, { start: 0, end: sessionBytes - 1 }) : Readable.from([]);
    await pipeline(sessionSource, new SessionCwdRewriter(cwd), createWriteStream(temp, { flags: "wx", mode: 0o600 })).catch(invalidBundle);
    const record = await readSessionJsonlFile(temp).catch((error: unknown) => {
      throw new SessionBundleError("INVALID_BUNDLE", `The bundled session is unreadable: ${error instanceof Error ? error.message : String(error)}`);
    });
    if (record.id !== header.sessionId) throw new SessionBundleError("INVALID_BUNDLE", "The bundle header and the session inside it disagree");
    for (const entry of native) {
      if (record.providerSessionIds?.[entry.provider] !== entry.providerSessionId) throw new SessionBundleError("INVALID_BUNDLE", "A native session in the bundle does not belong to this session");
    }

    const dir = getSessionDir(header.sessionId);
    const exists = await fs.stat(dir).then(() => true, () => false);
    let backupPath: string | undefined;
    if (exists) {
      if (!options.replace) throw new SessionBundleError("SESSION_EXISTS", `Session ${header.sessionId} already exists here; pass --replace to back it up and replace it`);
      // Kept outside sessions/ so listings do not show the old copy as a second session.
      backupPath = path.join(home.root, "backups", "sessions", `${header.sessionId}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
      await whenSessionWritesSettle();
      await fs.mkdir(path.dirname(backupPath), { recursive: true });
      await fs.rename(dir, backupPath);
    }
    await fs.mkdir(dir, { recursive: true });
    await fs.rename(temp, sessionFilePath(header.sessionId));

    // A native file that cannot be placed only costs the native resume; the transcript replay covers it.
    const kept: Record<string, string> = {};
    let offset = sessionBytes;
    for (const entry of native) {
      const placed = await placeNativeSession(entry, payload, offset, cwd ?? header.sourceCwd).then(() => true, () => false);
      if (placed) kept[entry.provider] = entry.providerSessionId;
      offset += entry.bytes;
    }
    const runtimeProvider = header.runtime?.provider ?? record.provider;
    // Appended as one metadata entry, keeping the store append-only. Ids without a moved file and external
    // directories only mean something on the source machine.
    await saveSession({
      ...record,
      provider: runtimeProvider,
      model: header.runtime?.model ?? record.model,
      effort: header.runtime?.effort ?? record.effort,
      providerSessionIds: kept,
      externalDirectories: [],
      pendingMoveNote: movedSessionNote(header, cwd, Boolean(runtimeProvider && kept[runtimeProvider]))
    });
    return { sessionId: header.sessionId, messages: record.messages.length, replaced: exists, ...(backupPath ? { backupPath } : {}), native: Object.keys(kept) as NativeSessionProvider[] };
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    await fs.rm(payload, { force: true }).catch(() => undefined);
  }
}

function invalidBundle(error: unknown): never {
  throw error instanceof SessionBundleError ? error : new SessionBundleError("INVALID_BUNDLE", `The bundle could not be read: ${error instanceof Error ? error.message : String(error)}`);
}
