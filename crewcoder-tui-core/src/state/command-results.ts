import type { TuiDecisionExplanation, TuiGoal, TuiReviewSummary } from "./tui-store.js";

/**
 * Pure parsers for one-shot CrewCoder CLI results and slash-command input,
 * shared by the legacy and OpenTUI terminal UIs.
 */

export type CompactionCliResult = { compacted: boolean; originalMessageCount?: number; retainedMessageCount?: number };

export type GoalStartInput = {
  objective: string;
  maxTurns?: number;
  checkModel?: string;
  disableCheckModel?: boolean;
  timeoutMinutes?: number;
};

export function parseCompactionResult(stdout: string): CompactionCliResult {
  const parsed = JSON.parse(stdout || "{}");
  const record = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  return {
    compacted: record.compacted === true,
    originalMessageCount: typeof record.originalMessageCount === "number" ? record.originalMessageCount : undefined,
    retainedMessageCount: typeof record.retainedMessageCount === "number" ? record.retainedMessageCount : undefined
  };
}

export function parseReviewSummary(stdout: string): TuiReviewSummary {
  const parsed = JSON.parse(stdout || "{}");
  const record = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  return {
    branch: typeof record.branch === "string" && record.branch.trim() ? record.branch : undefined,
    clean: record.clean === true,
    changedFiles: stringList(record.changedFiles),
    issueReferences: issueReferenceList(record.issueReferences)
  };
}

/**
 * Parse `session why --json`. Returns undefined when the backend reported that
 * there is no decision to explain, so the caller can say so instead of rendering
 * an empty card.
 */
export function parseDecisionExplanation(stdout: string): TuiDecisionExplanation | undefined {
  const parsed: unknown = JSON.parse(stdout || "{}");
  const record = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  if (record.explained !== true) return undefined;
  const explanation = typeof record.explanation === "string" ? record.explanation.trim() : "";
  if (!explanation) return undefined;
  const decision = record.decision && typeof record.decision === "object" ? record.decision as Record<string, unknown> : {};
  const toolCalls = Array.isArray(decision.toolCalls) ? decision.toolCalls : [];
  return {
    explanation,
    source: record.source === "model" ? "model" : "transcript",
    fallbackReason: typeof record.fallbackReason === "string" && record.fallbackReason.trim() ? record.fallbackReason : undefined,
    toolCalls: toolCalls.flatMap((call) => {
      if (!call || typeof call !== "object") return [];
      const name = (call as Record<string, unknown>).name;
      return typeof name === "string" ? [name] : [];
    }),
    changedFiles: stringList(decision.changedFiles)
  };
}

export function parseGoalRecord(stdout: string): TuiGoal | undefined {
  const parsed: unknown = JSON.parse(stdout || "null");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const status = goalStatus(record.status);
  if (typeof record.id !== "string" || typeof record.objective !== "string" || !status) return undefined;
  const pending = record.pendingApproval && typeof record.pendingApproval === "object" && !Array.isArray(record.pendingApproval)
    ? record.pendingApproval as Record<string, unknown>
    : undefined;
  return {
    id: record.id,
    objective: record.objective,
    status,
    provider: typeof record.provider === "string" ? record.provider : "unknown",
    model: typeof record.model === "string" ? record.model : "unknown",
    cycle: typeof record.cycle === "number" ? record.cycle : 0,
    maxTurns: typeof record.maxTurns === "number" ? record.maxTurns : undefined,
    checkModel: typeof record.checkModel === "string" ? record.checkModel : undefined,
    timeoutMinutes: typeof record.timeoutMinutes === "number" ? record.timeoutMinutes : undefined,
    lastCheck: parseGoalCheck(record.lastCheck),
    sessionId: typeof record.sessionId === "string" ? record.sessionId : undefined,
    pauseReason: typeof record.pauseReason === "string" ? record.pauseReason : undefined,
    error: typeof record.error === "string" ? record.error : undefined,
    completionSummary: typeof record.completionSummary === "string" ? record.completionSummary : undefined,
    completionEvidence: typeof record.completionEvidence === "string" ? record.completionEvidence : undefined,
    pendingApproval: pending && typeof pending.toolName === "string" && typeof pending.reason === "string" ? { toolName: pending.toolName, reason: pending.reason } : undefined
  };
}

function parseGoalCheck(value: unknown): TuiGoal["lastCheck"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if ((record.verdict !== "continue" && record.verdict !== "complete") || typeof record.reason !== "string" || typeof record.model !== "string") return undefined;
  return { verdict: record.verdict, reason: record.reason, model: record.model, evidence: typeof record.evidence === "string" ? record.evidence : undefined };
}

function goalStatus(value: unknown): TuiGoal["status"] | undefined {
  if (value === "queued" || value === "running" || value === "awaiting_approval" || value === "paused" || value === "completed" || value === "failed" || value === "cancelled") return value;
  return undefined;
}

function issueReferenceList(value: unknown): TuiReviewSummary["issueReferences"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || typeof record.text !== "string") return [];
    return [{
      id: record.id,
      source: typeof record.source === "string" ? record.source : "status",
      text: record.text,
      url: typeof record.url === "string" ? record.url : undefined
    }];
  });
}

export function parseGoalStartInput(parts: string[]): GoalStartInput {
  const objective: string[] = [];
  let maxTurns: number | undefined;
  let checkModel: string | undefined;
  let disableCheckModel = false;
  let timeoutMinutes: number | undefined;
  let positionalOnly = false;

  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    if (positionalOnly) { objective.push(part); continue; }
    if (part === "--") { positionalOnly = true; continue; }
    if (part === "--no-check-model") { disableCheckModel = true; continue; }
    const [name, inlineValue] = splitGoalOption(part);
    if (name === "--max-turns" || name === "--check-model" || name === "--timeout-minutes") {
      const value = inlineValue ?? parts[++index];
      if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value.`);
      if (name === "--max-turns") maxTurns = parseGoalOptionInteger(value, name, 10_000);
      else if (name === "--timeout-minutes") timeoutMinutes = parseGoalOptionInteger(value, name, 43_200);
      else {
        checkModel = value.trim();
        if (!checkModel) throw new Error("--check-model requires a non-empty model id.");
      }
      continue;
    }
    if (part.startsWith("--")) throw new Error(`Unknown /goal option: ${part}`);
    objective.push(part);
  }

  if (checkModel && disableCheckModel) throw new Error("Use either --check-model or --no-check-model, not both.");
  const text = objective.join(" ").trim();
  if (!text) throw new Error("Usage: /goal [--max-turns N] [--check-model MODEL|--no-check-model] [--timeout-minutes N] <objective>");
  return {
    objective: text,
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(checkModel ? { checkModel } : {}),
    ...(disableCheckModel ? { disableCheckModel: true } : {}),
    ...(timeoutMinutes !== undefined ? { timeoutMinutes } : {})
  };
}

export function tokenizeGoalCommand(input: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;
  let escaped = false;
  for (const char of input.trim()) {
    if (escaped) { current += char; escaped = false; continue; }
    if (char === "\\") { escaped = true; continue; }
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === "'" || char === "\"") { quote = char; continue; }
    if (/\s/.test(char)) {
      if (current) { parts.push(current); current = ""; }
      continue;
    }
    current += char;
  }
  if (escaped) current += "\\";
  if (quote) throw new Error("Unclosed quote in /goal command.");
  if (current) parts.push(current);
  return parts;
}

function splitGoalOption(part: string): [string, string | undefined] {
  const equals = part.indexOf("=");
  return equals === -1 ? [part, undefined] : [part.slice(0, equals), part.slice(equals + 1)];
}

function parseGoalOptionInteger(value: string, name: string, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error(`${name} must be an integer from 1 to ${maximum}.`);
  return parsed;
}

/**
 * Parses `/set-budget` input. Mirrors `parseTokenBudget` in the agent package
 * (`core/token-budget.ts`) so the TUI and `--budget` accept the same shorthand.
 * Returns undefined for anything invalid; the caller reports usage.
 */
export function parseBudgetInput(value: string): number | undefined {
  const normalized = value.trim().toLowerCase().replaceAll("_", "").replaceAll(",", "");
  const match = /^(\d+(?:\.\d+)?)(k|m)?$/.exec(normalized);
  if (!match) return undefined;
  const multiplier = match[2] === "k" ? 1_000 : match[2] === "m" ? 1_000_000 : 1;
  const tokens = Math.floor(Number(match[1]) * multiplier);
  if (!Number.isSafeInteger(tokens) || tokens < 1) return undefined;
  return tokens;
}

export function formatBudgetTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(2))}m`;
  if (tokens >= 1_000) return `${Number((tokens / 1_000).toFixed(1))}k`;
  return String(tokens);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
