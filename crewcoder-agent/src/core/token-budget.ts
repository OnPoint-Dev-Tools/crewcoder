import type { UsageSummary } from "./usage.js";

export type TokenBudgetStatus = {
  limit: number;
  used: number;
  remaining: number;
  percent: number;
  warningThreshold: number;
  warningReached: boolean;
  exceeded: boolean;
};

export const TOKEN_BUDGET_WARNING_PERCENT = 80;

export function parseTokenBudget(value: string | number | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value === "number") return validateBudget(value);
  const normalized = value.trim().toLowerCase().replaceAll("_", "").replaceAll(",", "");
  const match = /^(\d+(?:\.\d+)?)(k|m)?$/.exec(normalized);
  if (!match) throw new Error("Token budget must be a positive integer or shorthand such as 50k or 1.5m");
  const amount = Number(match[1]);
  const multiplier = match[2] === "k" ? 1_000 : match[2] === "m" ? 1_000_000 : 1;
  return validateBudget(amount * multiplier);
}

export function tokenBudgetStatus(usage: UsageSummary, limit: number): TokenBudgetStatus {
  const used = Math.max(0, usage.totalTokens ?? ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)));
  const percent = limit > 0 ? Math.round((used / limit) * 10_000) / 100 : 100;
  return {
    limit,
    used,
    remaining: Math.max(0, limit - used),
    percent,
    warningThreshold: TOKEN_BUDGET_WARNING_PERCENT,
    warningReached: percent >= TOKEN_BUDGET_WARNING_PERCENT,
    exceeded: used >= limit
  };
}

function validateBudget(value: number): number {
  const rounded = Math.floor(value);
  if (!Number.isSafeInteger(rounded) || rounded < 1) throw new Error("Token budget must be a positive integer");
  return rounded;
}
