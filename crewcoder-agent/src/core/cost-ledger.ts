import fs from "node:fs/promises";
import path from "node:path";
import { ensureCrewCoderHome } from "./crewcoder-home.js";
import { computeCost, resolveModelPricing, type PricingSource } from "./model-pricing.js";
import type { ModelUsage } from "./usage.js";

/**
 * One append-only line per billed model turn. Token counts are copied verbatim
 * from the provider; `costUsd` is an estimate and is simply absent when no rate
 * is known for the model, so an unpriced model reads as "unknown" instead of
 * silently reading as free.
 */
export type CostLedgerEntry = {
  timestamp: string;
  providerId: string;
  model: string;
  sessionId?: string;
  worker?: string;
  cwd?: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  costUsd?: number;
  pricingSource?: PricingSource;
};

export type CostTotals = {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  costUsd: number;
  /** Turns whose model had no known rate; their tokens are counted, their cost is not. */
  unpricedTurns: number;
};

export type CostGroupBy = "model" | "provider" | "worker" | "session" | "day";

export type CostGroup = CostTotals & { key: string };

export type CostReport = {
  total: CostTotals;
  groups: CostGroup[];
  groupBy: CostGroupBy;
};

export type CostLedgerFilter = {
  since?: Date;
  until?: Date;
  sessionId?: string;
  worker?: string;
  model?: string;
  providerId?: string;
};

export function getCostLedgerPath(): string {
  return path.join(ensureCrewCoderHome().logsDir, "cost.jsonl");
}

/**
 * Prices a single model turn and appends it to the ledger. Never throws: a
 * failed ledger write must not take down an otherwise healthy agent run, so
 * callers get a reason back instead of an exception.
 */
export async function recordModelUsageCost(
  usage: ModelUsage,
  context: { sessionId?: string; worker?: string; cwd?: string; timestamp?: string } = {}
): Promise<{ entry?: CostLedgerEntry; error?: string }> {
  try {
    const pricing = await resolveModelPricing(usage.providerId, usage.model);
    const cost = pricing ? computeCost(usage, pricing) : undefined;
    const costUsd = cost?.costUsd ?? (typeof usage.costUsd === "number" && Number.isFinite(usage.costUsd) ? usage.costUsd : undefined);
    const entry: CostLedgerEntry = {
      timestamp: context.timestamp ?? new Date().toISOString(),
      providerId: usage.providerId,
      model: usage.model ?? "default",
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      ...(context.worker ? { worker: context.worker } : {}),
      ...(context.cwd ? { cwd: context.cwd } : {}),
      inputTokens: count(usage.inputTokens),
      outputTokens: count(usage.outputTokens),
      cachedInputTokens: count(usage.cachedInputTokens),
      cacheWriteTokens: count(usage.cacheWriteTokens),
      reasoningTokens: count(usage.reasoningTokens),
      totalTokens: count(usage.totalTokens) || count(usage.inputTokens) + count(usage.outputTokens),
      ...(costUsd === undefined ? {} : { costUsd }),
      ...(pricing ? { pricingSource: pricing.source } : {})
    };
    await appendCostLedger(entry);
    return { entry };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export async function appendCostLedger(entry: CostLedgerEntry): Promise<void> {
  const file = getCostLedgerPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(entry)}\n`, "utf8");
}

export async function readCostLedger(filter: CostLedgerFilter = {}): Promise<CostLedgerEntry[]> {
  let content = "";
  try {
    content = await fs.readFile(getCostLedgerPath(), "utf8");
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }

  const entries: CostLedgerEntry[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    const parsed = parseEntry(line);
    if (parsed && matchesFilter(parsed, filter)) entries.push(parsed);
  }
  return entries;
}

export function summarizeCosts(entries: CostLedgerEntry[], groupBy: CostGroupBy): CostReport {
  const groups = new Map<string, CostGroup>();
  let total = emptyTotals();
  for (const entry of entries) {
    total = addEntry(total, entry);
    const key = groupKey(entry, groupBy);
    const existing = groups.get(key) ?? { key, ...emptyTotals() };
    groups.set(key, { key, ...addEntry(existing, entry) });
  }
  return {
    total,
    groups: [...groups.values()].sort((left, right) => right.costUsd - left.costUsd || right.totalTokens - left.totalTokens),
    groupBy
  };
}

export function startOfToday(now: Date = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function groupKey(entry: CostLedgerEntry, groupBy: CostGroupBy): string {
  if (groupBy === "model") return `${entry.providerId}:${entry.model}`;
  if (groupBy === "provider") return entry.providerId;
  if (groupBy === "worker") return entry.worker ?? "(unknown worker)";
  if (groupBy === "session") return entry.sessionId ?? "(no session)";
  return entry.timestamp.slice(0, 10);
}

function addEntry(totals: CostTotals, entry: CostLedgerEntry): CostTotals {
  return {
    turns: totals.turns + 1,
    inputTokens: totals.inputTokens + entry.inputTokens,
    outputTokens: totals.outputTokens + entry.outputTokens,
    cachedInputTokens: totals.cachedInputTokens + entry.cachedInputTokens,
    cacheWriteTokens: totals.cacheWriteTokens + entry.cacheWriteTokens,
    reasoningTokens: totals.reasoningTokens + entry.reasoningTokens,
    totalTokens: totals.totalTokens + entry.totalTokens,
    costUsd: totals.costUsd + (entry.costUsd ?? 0),
    unpricedTurns: totals.unpricedTurns + (typeof entry.costUsd === "number" ? 0 : 1)
  };
}

function emptyTotals(): CostTotals {
  return { turns: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0, costUsd: 0, unpricedTurns: 0 };
}

function matchesFilter(entry: CostLedgerEntry, filter: CostLedgerFilter): boolean {
  const at = Date.parse(entry.timestamp);
  if (filter.since && !(at >= filter.since.getTime())) return false;
  if (filter.until && !(at <= filter.until.getTime())) return false;
  if (filter.sessionId && entry.sessionId !== filter.sessionId) return false;
  if (filter.worker && entry.worker?.toLowerCase() !== filter.worker.toLowerCase()) return false;
  if (filter.providerId && entry.providerId !== filter.providerId) return false;
  if (filter.model && entry.model !== filter.model) return false;
  return true;
}

function parseEntry(line: string): CostLedgerEntry | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!isRecord(parsed)) return undefined;
    if (typeof parsed.timestamp !== "string" || typeof parsed.providerId !== "string" || typeof parsed.model !== "string") return undefined;
    if (Number.isNaN(Date.parse(parsed.timestamp))) return undefined;
    return {
      timestamp: parsed.timestamp,
      providerId: parsed.providerId,
      model: parsed.model,
      ...(typeof parsed.sessionId === "string" ? { sessionId: parsed.sessionId } : {}),
      ...(typeof parsed.worker === "string" ? { worker: parsed.worker } : {}),
      ...(typeof parsed.cwd === "string" ? { cwd: parsed.cwd } : {}),
      inputTokens: count(parsed.inputTokens),
      outputTokens: count(parsed.outputTokens),
      cachedInputTokens: count(parsed.cachedInputTokens),
      cacheWriteTokens: count(parsed.cacheWriteTokens),
      reasoningTokens: count(parsed.reasoningTokens),
      totalTokens: count(parsed.totalTokens),
      ...(typeof parsed.costUsd === "number" && Number.isFinite(parsed.costUsd) ? { costUsd: parsed.costUsd } : {}),
      ...(parsed.pricingSource === "config" || parsed.pricingSource === "openrouter" ? { pricingSource: parsed.pricingSource } : {})
    };
  } catch {
    return undefined;
  }
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
