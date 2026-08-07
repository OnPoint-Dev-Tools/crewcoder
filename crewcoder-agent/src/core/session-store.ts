import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import readline from "node:readline";
import path from "node:path";
import { ensureCrewCoderHome } from "./crewcoder-home.js";
import type { AgentEvent } from "./events.js";
import type { AgentMessage, ToolResultMessage } from "./messages.js";
import type { ModelInput } from "./model-client.js";
import type { UsageSummary } from "./usage.js";
import type { SessionCompaction } from "./session-compaction.js";
import type { SessionCheckpoint, SessionCheckpointRestore } from "./session-checkpoints.js";
import type { CrewCoderExtSessionEntry } from "../extensions/api.js";

export type SessionModelTurn = { iteration: number; input: ModelInput; promptHash: string; responseHash: string; responseId: string };

export type SessionRecord = {
  id: string;
  startedAt: string;
  cwd: string;
  externalDirectories?: string[];
  providerSessionIds?: Record<string, string>;
  requestedMode: string;
  resolvedMode: string;
  prompt: string;
  /** Provider of the most recent run, not necessarily the one the session started on. */
  provider?: string;
  /** Model of the most recent run, not necessarily the one the session started on. */
  model?: string;
  /** Reasoning effort of the most recent run. Restored on resume. */
  effort?: string;
  events: AgentEvent[];
  messages: AgentMessage[];
  modelTurns?: SessionModelTurn[];
  mutationLog: string[];
  usage?: UsageSummary;
  compactions?: SessionCompaction[];
  checkpoints?: SessionCheckpoint[];
  checkpointRestores?: SessionCheckpointRestore[];
  extensionState?: Record<string, unknown>;
  extensionEntries?: CrewCoderExtSessionEntry[];
  parentSessionId?: string;
  pendingResumeContext?: string;
  systemPrompt?: { name: string; path: string };
  /** Set when the session file could not be fully parsed; a header-only stub was returned. */
  loadError?: string;
};

type SessionHeaderEntry = {
  type: "session";
  version: 2;
  id: string;
  timestamp: string;
  cwd: string;
  externalDirectories?: string[];
  providerSessionIds?: Record<string, string>;
  requestedMode: string;
  resolvedMode: string;
  prompt: string;
  provider?: string;
  model?: string;
  parentSessionId?: string;
  systemPrompt?: { name: string; path: string };
};

type BaseEntry = { type: string; id: string; parentId: string | null; timestamp: string };
type MessageEntry = BaseEntry & { type: "message"; message: Exclude<AgentMessage, ToolResultMessage> };
type ToolEntry = BaseEntry & { type: "tool"; message: ToolResultMessage };
type CompactionEntry = BaseEntry & { type: "compaction"; compaction: SessionCompaction; firstKeptEntryId?: string };
type MetadataEntry = BaseEntry & {
  type: "metadata";
  /**
   * When true, the array fields (`events`, `mutationLog`, `modelTurns`,
   * `extensionEntries`) hold only the items added since the previous save, not a
   * cumulative snapshot. Legacy entries omit this and carry a full snapshot.
   * This is what keeps session files linear instead of O(n^2) in save count.
   */
  delta?: boolean;
  events?: AgentEvent[];
  mutationLog?: string[];
  usage?: UsageSummary;
  checkpoints?: SessionCheckpoint[];
  checkpointRestores?: SessionCheckpointRestore[];
  extensionEntries?: CrewCoderExtSessionEntry[];
  pendingResumeContext?: string | null;
  externalDirectories?: string[];
  providerSessionIds?: Record<string, string>;
  modelTurns?: SessionModelTurn[];
};
type BranchSummaryEntry = BaseEntry & { type: "branch_summary"; fromId: string; summary: string };
type LeafEntry = BaseEntry & { type: "leaf"; targetId: string | null };

export type SessionJsonlEntry = SessionHeaderEntry | MessageEntry | ToolEntry | CompactionEntry | MetadataEntry | BranchSummaryEntry | LeafEntry;

export function createSessionId(): string {
  return `session_${new Date().toISOString().replace(/[:.]/g, "-")}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createSessionEntryId(): string {
  return `entry_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function getSessionsDir(): string {
  return ensureCrewCoderHome().sessionsDir;
}

export function getSessionDir(sessionId: string): string {
  return path.join(getSessionsDir(), sessionId);
}

export function sessionFilePath(sessionId: string): string {
  return path.join(getSessionDir(sessionId), "session.jsonl");
}

export function legacySessionFilePath(sessionId: string): string {
  return path.join(getSessionDir(sessionId), "session.json");
}

export function sessionRuntimeFilePath(sessionId: string): string {
  return path.join(getSessionDir(sessionId), "runtime.json");
}

/**
 * Provider/model/effort of the session's most recent run.
 *
 * The `session` header entry is written once and never rewritten, because the
 * JSONL store is append-only and rewriting line 1 of a multi-hundred-megabyte
 * session on every save is not an option. The header therefore records what the
 * session STARTED on, so a user who switched model or effort mid-session used to
 * resume back onto the original settings.
 *
 * This sidecar is a fixed-size file rewritten only when the values actually
 * change, so the header-only listing path can read it without giving up the
 * O(1)-per-session cost that makes `/sessions` fast.
 */
type SessionRuntimeFile = { provider?: string; model?: string; effort?: string; updatedAt: string };

/**
 * Session writes currently in flight.
 *
 * `session.jsonl` is appended in whole-entry chunks, but an append is not atomic:
 * a process killed mid-write can leave a truncated line, and one unparseable line
 * makes the whole session unreadable. Per-turn saving multiplies the number of
 * those windows, so signal handlers drain this set before exiting.
 */
const inFlightSessionWrites = new Set<Promise<string>>();

/** Resolves once every in-flight session write has finished (successfully or not). */
export async function whenSessionWritesSettle(): Promise<void> {
  while (inFlightSessionWrites.size) {
    await Promise.allSettled([...inFlightSessionWrites]);
  }
}

export async function saveSession(record: SessionRecord): Promise<string> {
  const write = writeSessionRecord(record);
  inFlightSessionWrites.add(write);
  try {
    return await write;
  } finally {
    inFlightSessionWrites.delete(write);
  }
}

async function readSessionRuntime(sessionId: string): Promise<SessionRuntimeFile | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(sessionRuntimeFilePath(sessionId), "utf8");
  } catch {
    return undefined;
  }
  // Treated as untrusted input: a hand-edited or truncated sidecar must degrade to
  // the header values, never poison the resumed run with a non-string model id.
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed !== "object" || parsed === null) return undefined;
    return {
      provider: typeof parsed.provider === "string" ? parsed.provider : undefined,
      model: typeof parsed.model === "string" ? parsed.model : undefined,
      effort: typeof parsed.effort === "string" ? parsed.effort : undefined,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : ""
    };
  } catch {
    return undefined;
  }
}

async function writeSessionRuntime(record: SessionRecord): Promise<void> {
  if (record.provider === undefined && record.model === undefined && record.effort === undefined) return;
  const existing = await readSessionRuntime(record.id);
  if (existing && existing.provider === record.provider && existing.model === record.model && existing.effort === record.effort) return;
  const file = sessionRuntimeFilePath(record.id);
  const payload: SessionRuntimeFile = { provider: record.provider, model: record.model, effort: record.effort, updatedAt: new Date().toISOString() };
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(temp, `${JSON.stringify(payload)}\n`, "utf8");
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}

function withSessionRuntime(record: SessionRecord, runtime: SessionRuntimeFile | undefined): SessionRecord {
  if (!runtime) return record;
  return {
    ...record,
    provider: runtime.provider ?? record.provider,
    model: runtime.model ?? record.model,
    effort: runtime.effort ?? record.effort
  };
}

async function writeSessionRecord(record: SessionRecord): Promise<string> {
  const dir = getSessionDir(record.id);
  await fs.mkdir(dir, { recursive: true });
  await writeSessionRuntime(record);
  const file = sessionFilePath(record.id);
  const existing = await loadSessionJsonlEntries(file).catch(() => []);
  if (!existing.length) {
    await fs.writeFile(file, `${recordToJsonl(record).map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
    return file;
  }

  const existingRecord = entriesToRecord(existing);
  const existingMessagesArePrefix = existingRecord.messages.every((message, index) => JSON.stringify(record.messages[index]) === JSON.stringify(message));
  if (!existingMessagesArePrefix) {
    // Compaction and explicit history replacement are not append-only. Rewrite
    // atomically so stale pre-compaction messages cannot reappear after reload.
    const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
    try {
      await fs.writeFile(temp, `${recordToJsonl(record).map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
      await fs.rename(temp, file);
    } finally {
      await fs.rm(temp, { force: true }).catch(() => undefined);
    }
    return file;
  }
  const entries = appendEntriesForRecordDelta(existing, record, existingRecord);
  if (entries.length) await fs.appendFile(file, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""), "utf8");
  return file;
}

export async function loadSessionRecord(sessionId: string): Promise<SessionRecord> {
  const jsonlFile = sessionFilePath(sessionId);
  const jsonl = await loadSessionJsonlEntries(jsonlFile).catch(() => []);
  if (jsonl.length) return withSessionRuntime(entriesToRecord(jsonl), await readSessionRuntime(sessionId));
  const legacy = JSON.parse(await fs.readFile(legacySessionFilePath(sessionId), "utf8")) as SessionRecord;
  await saveSession(legacy).catch(() => undefined);
  return legacy;
}

export async function listSessions(cwd = process.cwd()): Promise<SessionRecord[]> {
  return listSessionsForProject(path.resolve(cwd));
}

export async function listAllSessions(): Promise<SessionRecord[]> {
  return listSessionsForProject(undefined);
}

/**
 * Header-only listing. Reads just the first JSONL line of each session instead of
 * parsing the whole file.
 *
 * This exists because listings are the hot path and need almost nothing: id,
 * startedAt, cwd, mode, prompt, provider, model — all of which live in the header
 * entry. `listSessionsForProject` fully parses every session (messages, events,
 * mutation log, model turns) and then throws nearly all of it away. On a real store
 * of ~500 sessions / ~570 MB of JSONL that measured 4.4s, and the cwd filter ran
 * *after* the parse, so listing a project with zero sessions still cost the full 4.1s.
 *
 * Anything that genuinely needs message/event bodies must still call
 * `listAllSessions`/`listSessions`.
 */
export async function listSessionHeaders(projectCwd?: string): Promise<SessionRecord[]> {
  const sessionsDir = getSessionsDir();
  await fs.mkdir(sessionsDir, { recursive: true });
  const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
  const headers = await Promise.all(entries.map(async (entry) => {
    if (!entry.isDirectory()) return undefined;
    return readSessionHeaderRecord(entry.name).catch(() => undefined);
  }));
  return headers
    .filter((record): record is SessionRecord => record !== undefined)
    .filter((record) => projectCwd === undefined || path.resolve(record.cwd) === projectCwd)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

async function listSessionsForProject(projectCwd: string | undefined): Promise<SessionRecord[]> {
  const sessionsDir = getSessionsDir();
  await fs.mkdir(sessionsDir, { recursive: true });
  const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
  const sessions: SessionRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const record = await loadSessionRecord(entry.name);
      if (projectCwd !== undefined && path.resolve(record.cwd) !== projectCwd) continue;
      sessions.push(record);
    } catch (error) {
      // Never let a broken session silently disappear — surface a header stub so
      // the user still sees it exists (and can tell it failed to load).
      const stub = await loadSessionHeaderStub(entry.name, error).catch(() => undefined);
      if (!stub) continue;
      if (projectCwd !== undefined && path.resolve(stub.cwd) !== projectCwd) continue;
      sessions.push(stub);
    }
  }
  return sessions.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

// Streaming deltas are live-UI only and account for the overwhelming majority of
// event volume; persisting them re-serialized on every save is what blew a single
// session file past 500MB. Keep durable lifecycle/tool events; drop the deltas.
const LIVE_DELTA_EVENT_TYPES = new Set(["assistant_delta", "tool_delta", "thinking_delta"]);

function persistableEvents(events: AgentEvent[] | undefined): AgentEvent[] {
  return (events ?? []).filter((event) => !LIVE_DELTA_EVENT_TYPES.has(event.type));
}

type MetadataArrayKey = "events" | "mutationLog" | "modelTurns" | "extensionEntries";

/**
 * Rebuild a cumulative array from metadata entries. `delta` entries are
 * concatenated; a legacy (snapshot) entry replaces the accumulator so old files
 * still read correctly, and a legacy-then-delta file bases off the last snapshot.
 */
function foldMetadataArray<T>(metas: MetadataEntry[], key: MetadataArrayKey): T[] {
  let result: T[] = [];
  for (const meta of metas) {
    const value = meta[key];
    if (!Array.isArray(value)) continue;
    result = meta.delta ? result.concat(value as T[]) : (value as T[]);
  }
  return result;
}

function latestMetadataField<K extends keyof MetadataEntry>(metas: MetadataEntry[], key: K): MetadataEntry[K] | undefined {
  for (let i = metas.length - 1; i >= 0; i--) {
    const value = metas[i]![key];
    if (value !== undefined) return value;
  }
  return undefined;
}

function metadataEntry(record: SessionRecord, parentId: string | null, arrays: Pick<MetadataEntry, MetadataArrayKey>): MetadataEntry {
  return {
    type: "metadata",
    id: createSessionEntryId(),
    parentId,
    timestamp: new Date().toISOString(),
    delta: true,
    events: arrays.events,
    mutationLog: arrays.mutationLog,
    modelTurns: arrays.modelTurns,
    extensionEntries: arrays.extensionEntries,
    usage: record.usage,
    checkpoints: record.checkpoints,
    checkpointRestores: record.checkpointRestores,
    pendingResumeContext: record.pendingResumeContext ?? null,
    externalDirectories: record.externalDirectories ?? [],
    providerSessionIds: record.providerSessionIds ?? {}
  };
}

function recordToJsonl(record: SessionRecord): SessionJsonlEntry[] {
  const header: SessionHeaderEntry = {
    type: "session",
    version: 2,
    id: record.id,
    timestamp: record.startedAt,
    cwd: record.cwd,
    externalDirectories: record.externalDirectories,
    providerSessionIds: record.providerSessionIds,
    requestedMode: record.requestedMode,
    resolvedMode: record.resolvedMode,
    prompt: record.prompt,
    provider: record.provider,
    model: record.model,
    parentSessionId: record.parentSessionId,
    systemPrompt: record.systemPrompt
  };
  const entries: SessionJsonlEntry[] = [header];
  let parentId: string | null = null;
  for (const message of record.messages) {
    const id = createSessionEntryId();
    const entry = message.role === "toolResult"
      ? { type: "tool" as const, id, parentId, timestamp: new Date(message.timestamp).toISOString(), message }
      : { type: "message" as const, id, parentId, timestamp: new Date(message.timestamp).toISOString(), message };
    entries.push(entry);
    parentId = id;
  }
  for (const compaction of record.compactions ?? []) {
    const id = createSessionEntryId();
    entries.push({ type: "compaction", id, parentId, timestamp: compaction.createdAt, compaction });
    parentId = id;
  }
  entries.push(metadataEntry(record, parentId, {
    events: persistableEvents(record.events),
    mutationLog: record.mutationLog,
    modelTurns: record.modelTurns,
    extensionEntries: record.extensionEntries
  }));
  return entries;
}

function appendEntriesForRecordDelta(existing: SessionJsonlEntry[], record: SessionRecord, existingRecord: SessionRecord): SessionJsonlEntry[] {
  const entries: SessionJsonlEntry[] = [];
  let parentId = currentLeafId(existing);
  for (const message of record.messages.slice(existingRecord.messages.length)) {
    const id = createSessionEntryId();
    const entry = message.role === "toolResult"
      ? { type: "tool" as const, id, parentId, timestamp: new Date(message.timestamp).toISOString(), message }
      : { type: "message" as const, id, parentId, timestamp: new Date(message.timestamp).toISOString(), message };
    entries.push(entry);
    parentId = id;
  }
  for (const compaction of (record.compactions ?? []).slice(existingRecord.compactions?.length ?? 0)) {
    const id = createSessionEntryId();
    entries.push({ type: "compaction", id, parentId, timestamp: compaction.createdAt, compaction });
    parentId = id;
  }
  // Append only the array items added since the last save. `existingRecord` is the
  // already-persisted cumulative state, so slicing by its lengths yields the delta.
  entries.push(metadataEntry(record, parentId, {
    events: tailFrom(persistableEvents(record.events), existingRecord.events.length),
    mutationLog: tailFrom(record.mutationLog, existingRecord.mutationLog.length),
    modelTurns: tailFrom(record.modelTurns ?? [], existingRecord.modelTurns?.length ?? 0),
    extensionEntries: tailFrom(record.extensionEntries ?? [], existingRecord.extensionEntries?.length ?? 0)
  }));
  return entries;
}

/** Items past `alreadyPersisted`; empty when the baseline is longer (e.g. a legacy snapshot counted deltas). */
function tailFrom<T>(items: T[], alreadyPersisted: number): T[] {
  return items.length > alreadyPersisted ? items.slice(alreadyPersisted) : [];
}

function entriesToRecord(entries: SessionJsonlEntry[]): SessionRecord {
  const header = entries.find((entry): entry is SessionHeaderEntry => entry.type === "session");
  if (!header) throw new Error("Session JSONL is missing a session header");
  const pathEntries = pathToLeaf(entries);
  const metadataEntries = entries.filter((entry): entry is MetadataEntry => entry.type === "metadata");
  const compactions = pathEntries.flatMap((entry) => entry.type === "compaction" ? [entry.compaction] : []);
  return {
    id: header.id,
    startedAt: header.timestamp,
    cwd: header.cwd,
    externalDirectories: latestMetadataField(metadataEntries, "externalDirectories") ?? header.externalDirectories,
    providerSessionIds: latestMetadataField(metadataEntries, "providerSessionIds") ?? header.providerSessionIds,
    requestedMode: header.requestedMode,
    resolvedMode: header.resolvedMode,
    prompt: header.prompt,
    provider: header.provider,
    model: header.model,
    parentSessionId: header.parentSessionId,
    systemPrompt: header.systemPrompt,
    events: foldMetadataArray<AgentEvent>(metadataEntries, "events"),
    messages: pathEntries.flatMap((entry) => entry.type === "message" || entry.type === "tool" ? [entry.message] : []),
    mutationLog: foldMetadataArray<string>(metadataEntries, "mutationLog"),
    usage: latestMetadataField(metadataEntries, "usage"),
    compactions,
    checkpoints: latestMetadataField(metadataEntries, "checkpoints"),
    checkpointRestores: latestMetadataField(metadataEntries, "checkpointRestores"),
    extensionEntries: foldMetadataArray<CrewCoderExtSessionEntry>(metadataEntries, "extensionEntries"),
    pendingResumeContext: latestMetadataField(metadataEntries, "pendingResumeContext") ?? undefined,
    modelTurns: foldMetadataArray<SessionModelTurn>(metadataEntries, "modelTurns")
  };
}

function pathToLeaf(entries: SessionJsonlEntry[]): Array<Exclude<SessionJsonlEntry, SessionHeaderEntry>> {
  const treeEntries = entries.filter((entry): entry is Exclude<SessionJsonlEntry, SessionHeaderEntry> => entry.type !== "session");
  const byId = new Map(treeEntries.map((entry) => [entry.id, entry]));
  let currentId = currentLeafId(entries);
  const result: Array<Exclude<SessionJsonlEntry, SessionHeaderEntry>> = [];
  while (currentId) {
    const entry = byId.get(currentId);
    if (!entry) break;
    if (entry.type !== "leaf") result.unshift(entry);
    currentId = entry.parentId;
  }
  return result;
}

function currentLeafId(entries: SessionJsonlEntry[]): string | null {
  let leafId: string | null = null;
  for (const entry of entries) {
    if (entry.type === "session") continue;
    leafId = entry.type === "leaf" ? entry.targetId : entry.id;
  }
  return leafId;
}

async function loadSessionJsonlEntries(file: string): Promise<SessionJsonlEntry[]> {
  // Read line by line rather than slurping the whole file into one string: a
  // bloated session can exceed V8's max string length, and readFile would throw,
  // making the whole session unreadable (and silently dropped from listings).
  const entries: SessionJsonlEntry[] = [];
  const rl = readline.createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      entries.push(JSON.parse(line) as SessionJsonlEntry);
    }
  } finally {
    rl.close();
  }
  return entries;
}

/**
 * Cheap header-only load: reads just the first `session` line and stops. The
 * stream is destroyed rather than drained, so a 100 MB session costs one read,
 * not a full pass.
 *
 * Falls back to the legacy single-JSON format, which predates JSONL and has no
 * cheap header — those files are small and rare, so a full parse is acceptable.
 */
async function readSessionHeaderRecord(sessionId: string): Promise<SessionRecord | undefined> {
  const header = await readSessionHeaderEntry(sessionId).catch(() => undefined);
  if (header) return withSessionRuntime(headerToRecord(header), await readSessionRuntime(sessionId));

  const legacy = JSON.parse(await fs.readFile(legacySessionFilePath(sessionId), "utf8")) as SessionRecord;
  return { ...legacy, events: [], messages: [], mutationLog: [] };
}

async function readSessionHeaderEntry(sessionId: string): Promise<SessionHeaderEntry | undefined> {
  const stream = createReadStream(sessionFilePath(sessionId), "utf8");
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      const parsed = JSON.parse(line) as SessionJsonlEntry;
      return parsed.type === "session" ? parsed : undefined;
    }
    return undefined;
  } finally {
    rl.close();
    stream.destroy();
  }
}

function headerToRecord(header: SessionHeaderEntry): SessionRecord {
  return {
    id: header.id,
    startedAt: header.timestamp,
    cwd: header.cwd,
    externalDirectories: header.externalDirectories,
    providerSessionIds: header.providerSessionIds,
    requestedMode: header.requestedMode,
    resolvedMode: header.resolvedMode,
    prompt: header.prompt,
    provider: header.provider,
    model: header.model,
    parentSessionId: header.parentSessionId,
    systemPrompt: header.systemPrompt,
    events: [],
    messages: [],
    mutationLog: []
  };
}

/**
 * Header-only stub for a session that failed a full parse, so it still surfaces
 * in listings (marked with `loadError`) instead of vanishing as if deleted.
 */
async function loadSessionHeaderStub(sessionId: string, error: unknown): Promise<SessionRecord | undefined> {
  const header = await readSessionHeaderEntry(sessionId);
  if (!header) return undefined;
  const record = withSessionRuntime(headerToRecord(header), await readSessionRuntime(sessionId));
  return { ...record, loadError: error instanceof Error ? error.message : String(error) };
}
