import fs from "node:fs";
import path from "node:path";
import { getCrewCoderHome } from "./crewcoder-home.js";
import type { FleetEventRecord, FleetRunRequest, FleetRunStatus } from "./fleet-types.js";

export const FLEET_RUN_STORE_VERSION = 1 as const;

export type FleetRunMetadata = {
  version: typeof FLEET_RUN_STORE_VERSION;
  runId: string;
  request: FleetRunRequest;
  status: FleetRunStatus;
  sessionId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  eventCount: number;
  lastEventId: number;
};

export type StoredFleetRun = {
  metadata: FleetRunMetadata;
  events: FleetEventRecord[];
};

export class FleetRunStore {
  readonly root: string;

  constructor(root = path.join(getCrewCoderHome().root, "fleet-runs")) {
    this.root = path.resolve(root);
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(this.root, 0o700); } catch {}
  }

  loadRuns(): StoredFleetRun[] {
    const entries = fs.readdirSync(this.root, { withFileTypes: true });
    const runs: StoredFleetRun[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !isRunId(entry.name)) continue;
      const metadata = readMetadata(path.join(this.root, entry.name, "run.json"));
      if (!metadata || metadata.runId !== entry.name) continue;
      runs.push({ metadata, events: readEvents(path.join(this.root, entry.name, "events.jsonl")) });
    }
    return runs.sort((left, right) => left.metadata.createdAt.localeCompare(right.metadata.createdAt));
  }

  writeMetadata(metadata: FleetRunMetadata): void {
    const dir = this.runDirectory(metadata.runId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch {}
    writeJsonAtomic(path.join(dir, "run.json"), metadata);
  }

  appendEvent(runId: string, record: FleetEventRecord): void {
    const dir = this.runDirectory(runId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = path.join(dir, "events.jsonl");
    fs.appendFileSync(target, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    try { fs.chmodSync(target, 0o600); } catch {}
  }

  private runDirectory(runId: string): string {
    if (!isRunId(runId)) throw new Error(`Invalid fleet run id: ${runId}`);
    return path.join(this.root, runId);
  }
}

function readMetadata(file: string): FleetRunMetadata | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (record.version !== FLEET_RUN_STORE_VERSION || typeof record.runId !== "string" || !isRunStatus(record.status) || typeof record.createdAt !== "string" || typeof record.updatedAt !== "string" || typeof record.eventCount !== "number" || typeof record.lastEventId !== "number" || !record.request || typeof record.request !== "object" || Array.isArray(record.request)) return undefined;
    return {
      version: FLEET_RUN_STORE_VERSION,
      runId: record.runId,
      request: record.request as FleetRunRequest,
      status: record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      eventCount: record.eventCount,
      lastEventId: record.lastEventId,
      ...(typeof record.sessionId === "string" ? { sessionId: record.sessionId } : {}),
      ...(typeof record.error === "string" ? { error: record.error } : {})
    };
  } catch {
    return undefined;
  }
}

function readEvents(file: string): FleetEventRecord[] {
  try {
    const events: FleetEventRecord[] = [];
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line) as unknown;
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const record = value as Record<string, unknown>;
        if (!Number.isSafeInteger(record.id) || (record.id as number) < 1 || typeof record.emittedAt !== "string" || !record.event || typeof record.event !== "object" || Array.isArray(record.event) || typeof (record.event as Record<string, unknown>).type !== "string") continue;
        events.push({ id: record.id as number, emittedAt: record.emittedAt, event: record.event as FleetEventRecord["event"] });
      } catch {}
    }
    return events.sort((left, right) => left.id - right.id);
  } catch {
    return [];
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

function isRunId(value: string): boolean {
  return /^run_[A-Za-z0-9_-]+$/.test(value);
}

function isRunStatus(value: unknown): value is FleetRunStatus {
  return value === "running" || value === "completed" || value === "failed" || value === "aborted";
}
