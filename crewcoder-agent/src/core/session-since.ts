import { listSessions, loadSessionRecord, type SessionRecord } from "./session-store.js";
import { getText } from "./messages.js";

export type ToolRunCount = { name: string; count: number };

export type SessionSinceEntry = {
  sessionId: string;
  startedAt: string;
  prompt: string;
  mode: string;
  provider?: string;
  model?: string;
  changedFiles: string[];
  toolsRun: ToolRunCount[];
  decision?: string;
};

export type SessionSinceSummary = {
  ref: string;
  since: string;
  refSessionId?: string;
  cwd: string;
  sessions: SessionSinceEntry[];
  changedFiles: string[];
  toolsRun: ToolRunCount[];
  decisions: string[];
};

const MAX_CONTEXT_CHARS = 4000;

export function parseSinceRef(value: string): Date {
  const trimmed = value.trim();
  const relative = /^(\d+)(m|h|d)$/i.exec(trimmed);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    const multiplier = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
    return new Date(Date.now() - amount * multiplier);
  }
  const timestamp = Date.parse(trimmed);
  if (Number.isNaN(timestamp)) throw new Error("Provide a session id, an ISO timestamp, or a relative duration like 30m, 2h, 7d.");
  return new Date(timestamp);
}

async function resolveSinceRef(ref: string, cwd: string): Promise<{ since: Date; refSessionId?: string }> {
  try {
    const record = await loadSessionRecord(ref);
    return { since: new Date(record.startedAt), refSessionId: record.id };
  } catch {
    return { since: parseSinceRef(ref) };
  }
}

function countTools(record: SessionRecord): ToolRunCount[] {
  const counts = new Map<string, number>();
  for (const event of record.events) {
    if (event.type === "tool_execution_start") counts.set(event.toolName, (counts.get(event.toolName) ?? 0) + 1);
  }
  return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
}

function lastDecision(record: SessionRecord): string | undefined {
  for (let i = record.messages.length - 1; i >= 0; i--) {
    const message = record.messages[i];
    if (message.role !== "assistant") continue;
    const text = getText(message).trim();
    if (!text) continue;
    const firstLine = text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? text;
    return firstLine.length > 240 ? `${firstLine.slice(0, 240)}…` : firstLine;
  }
  return undefined;
}

function mergeToolRuns(entries: SessionSinceEntry[]): ToolRunCount[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    for (const run of entry.toolsRun) counts.set(run.name, (counts.get(run.name) ?? 0) + run.count);
  }
  return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
}

export async function summarizeSessionsSince(ref: string, options: { cwd?: string } = {}): Promise<SessionSinceSummary> {
  const cwd = options.cwd ?? process.cwd();
  const { since, refSessionId } = await resolveSinceRef(ref, cwd);
  const sinceMs = since.getTime();
  const records = (await listSessions(cwd))
    .filter((record) => new Date(record.startedAt).getTime() >= sinceMs)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));

  const sessions: SessionSinceEntry[] = records.map((record) => ({
    sessionId: record.id,
    startedAt: record.startedAt,
    prompt: record.prompt,
    mode: record.resolvedMode,
    provider: record.provider,
    model: record.model,
    changedFiles: [...new Set(record.mutationLog)],
    toolsRun: countTools(record),
    decision: lastDecision(record)
  }));

  return {
    ref,
    since: since.toISOString(),
    refSessionId,
    cwd,
    sessions,
    changedFiles: [...new Set(sessions.flatMap((entry) => entry.changedFiles))].sort(),
    toolsRun: mergeToolRuns(sessions),
    decisions: sessions.flatMap((entry) => (entry.decision ? [`${entry.sessionId}: ${entry.decision}`] : []))
  };
}

export function formatSessionSinceContext(summary: SessionSinceSummary): string {
  const lines: string[] = [`What changed since ${summary.ref} (${summary.since}) across ${summary.sessions.length} session(s):`];
  if (summary.changedFiles.length) {
    lines.push("", "Files touched:");
    for (const file of summary.changedFiles) lines.push(`- ${file}`);
  }
  if (summary.toolsRun.length) {
    lines.push("", `Tools run: ${summary.toolsRun.map((run) => `${run.name}×${run.count}`).join(", ")}`);
  }
  if (summary.decisions.length) {
    lines.push("", "Decisions / last outcomes:");
    for (const decision of summary.decisions) lines.push(`- ${decision}`);
  }
  const text = lines.join("\n");
  return text.length > MAX_CONTEXT_CHARS ? `${text.slice(0, MAX_CONTEXT_CHARS)}\n… (summary truncated)` : text;
}
