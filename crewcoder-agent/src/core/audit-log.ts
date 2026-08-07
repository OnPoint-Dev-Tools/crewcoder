import fs from "node:fs/promises";
import path from "node:path";
import { ensureCrewCoderHome } from "./crewcoder-home.js";
import { redactSecrets } from "./secret-redaction.js";

export type AuditEventType = "tool_call" | "tool_result" | "approval" | "write";

export type AuditLogEntry = {
  type: AuditEventType;
  timestamp: string;
  sessionId?: string;
  toolCallId?: string;
  toolName?: string;
  cwd?: string;
  approved?: boolean;
  risk?: string;
  reason?: string;
  path?: string;
  isError?: boolean;
  args?: Record<string, unknown>;
  details?: Record<string, unknown>;
};

export async function appendAuditLog(entry: Omit<AuditLogEntry, "timestamp"> & { timestamp?: string }): Promise<void> {
  const file = getAuditLogPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const record: AuditLogEntry = redactSecrets({
    ...entry,
    timestamp: entry.timestamp ?? new Date().toISOString()
  });
  await fs.appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
}

export async function readAuditLog(options: { since?: Date } = {}): Promise<AuditLogEntry[]> {
  const file = getAuditLogPath();
  let content = "";
  try {
    content = await fs.readFile(file, "utf8");
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }

  const entries: AuditLogEntry[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    const parsed = parseAuditLine(line);
    if (!parsed) continue;
    if (options.since && Date.parse(parsed.timestamp) < options.since.getTime()) continue;
    entries.push(parsed);
  }
  return entries;
}

export function getAuditLogPath(): string {
  return path.join(ensureCrewCoderHome().logsDir, "audit.jsonl");
}

function parseAuditLine(line: string): AuditLogEntry | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!isAuditLogEntry(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isAuditLogEntry(value: unknown): value is AuditLogEntry {
  if (!isRecord(value)) return false;
  return typeof value.type === "string" && typeof value.timestamp === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
