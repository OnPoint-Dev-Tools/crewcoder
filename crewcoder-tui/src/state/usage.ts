export type TuiUsageSummary = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  turns: number;
  /** Active model's context-window size (max input tokens), when the backend reports it. */
  contextWindow?: number;
  /** Most recent turn's input tokens: the live context-window occupancy. */
  lastInputTokens?: number;
  /** Durable session token ceiling and enforcement state. */
  tokenBudget?: number;
  budgetExceeded?: boolean;
  /** Estimated USD spend for this session, when the backend can price the model. */
  costUsd?: number;
};

/** Session spend for the status line. Sub-cent runs still need visible precision. */
export function formatUsd(value: number): string {
  if (value === 0) return "$0.00";
  if (Math.abs(value) < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

/**
 * Compact context-window status shown at the bottom-right of the composer:
 * `◔ 12.4k/200k - 6% | 12.4k tokens`.
 */
export function formatContextStatus(usage: TuiUsageSummary): string {
  return `${formatContextTokens(usage)}${formatCostSuffix(usage)}`;
}

function formatCostSuffix(usage: TuiUsageSummary): string {
  return typeof usage.costUsd === "number" && Number.isFinite(usage.costUsd) ? ` | ${formatUsd(usage.costUsd)}` : "";
}

function formatContextTokens(usage: TuiUsageSummary): string {
  const used = usage.lastInputTokens ?? usage.totalTokens ?? usage.inputTokens;
  const contextWindow = usage.contextWindow;
  const totalTokens = usage.totalTokens ?? used;

  if (typeof used === "number" && typeof contextWindow === "number" && contextWindow > 0) {
    const percent = boundedPercent(used, contextWindow);
    return `${contextGlyph(percent)} ${formatTokenCount(used)}/${formatTokenCount(contextWindow)} - ${percent}% | ${formatTokenCount(totalTokens ?? used)} tokens`;
  }

  if (typeof usage.tokenBudget === "number" && usage.tokenBudget > 0) {
    const spent = usage.totalTokens ?? ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0));
    const percent = boundedPercent(spent, usage.tokenBudget);
    return `${contextGlyph(percent)} ${formatTokenCount(spent)}/${formatTokenCount(usage.tokenBudget)} budget - ${percent}% | ${formatTokenCount(spent)} tokens`;
  }

  if (typeof totalTokens === "number") return `${formatTokenCount(totalTokens)} tokens`;
  return "?/? - ?% | ? tokens";
}

function boundedPercent(used: number, limit: number): number {
  return Math.max(0, Math.min(100, Math.round((used / limit) * 100)));
}

function contextGlyph(percent: number): string {
  if (percent <= 0) return "○";
  if (percent < 25) return "◔";
  if (percent < 50) return "◑";
  if (percent < 75) return "◕";
  return "●";
}

function formatTokenCount(value: number): string {
  const rounded = Math.round(value);
  if (Math.abs(rounded) >= 1_000_000) return `${trimDecimal(rounded / 1_000_000)}m`;
  if (Math.abs(rounded) >= 1_000) return `${trimDecimal(rounded / 1_000)}k`;
  return rounded.toLocaleString("en-US");
}

function trimDecimal(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}
