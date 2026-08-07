export type TokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  /** Tokens written to the prompt cache this turn (Anthropic cache_creation_input_tokens). */
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  /** Current provider-native context occupancy; separate from billable input. */
  contextTokens?: number;
  /**
   * True when `cachedInputTokens` is already counted inside `inputTokens`
   * (OpenAI `prompt_tokens_details.cached_tokens`), false/undefined when the
   * provider reports cache reads separately (Anthropic `cache_read_input_tokens`).
   * Cost accounting depends on this; without it cached input is either
   * double-billed or invisible.
   */
  cachedInputIncluded?: boolean;
  /** Estimated spend in USD, present only when a rate for the model is known. */
  costUsd?: number;
};

export type ModelUsage = TokenUsage & {
  providerId: string;
  model?: string;
};

export type ModelUsageBreakdown = ModelUsage & { turns: number };

export type UsageSummary = TokenUsage & {
  turns: number;
  /** Active model's context-window size (max input tokens), when known. */
  contextWindow?: number;
  /**
   * Active context occupancy reported by the provider, or the most recent input
   * tokens as a fallback. Unlike cumulative fields, this is replaced each turn
   * and drives auto-compaction.
   */
  lastInputTokens?: number;
  /** Per-model cumulative usage, keyed by `${providerId}:${model}`. */
  byModel?: Record<string, ModelUsageBreakdown>;
  /** Durable per-session cumulative token ceiling. */
  tokenBudget?: number;
  /** True after cumulative totalTokens reaches tokenBudget. */
  budgetExceeded?: boolean;
};

export function addUsage(summary: UsageSummary, usage?: ModelUsage): UsageSummary {
  if (!usage) return summary;
  return {
    inputTokens: addOptional(summary.inputTokens, usage.inputTokens),
    outputTokens: addOptional(summary.outputTokens, usage.outputTokens),
    totalTokens: addOptional(summary.totalTokens, usage.totalTokens),
    cachedInputTokens: addOptional(summary.cachedInputTokens, usage.cachedInputTokens),
    cacheWriteTokens: addOptional(summary.cacheWriteTokens, usage.cacheWriteTokens),
    reasoningTokens: addOptional(summary.reasoningTokens, usage.reasoningTokens),
    costUsd: addOptional(summary.costUsd, usage.costUsd),
    turns: summary.turns + 1,
    contextWindow: summary.contextWindow,
    lastInputTokens: typeof usage.contextTokens === "number" ? usage.contextTokens : typeof usage.inputTokens === "number" ? usage.inputTokens : summary.lastInputTokens,
    byModel: addModelUsage(summary.byModel, usage),
    tokenBudget: summary.tokenBudget,
    budgetExceeded: summary.budgetExceeded
  };
}

export function emptyUsageSummary(): UsageSummary {
  return { turns: 0 };
}

export function modelUsageKey(usage: Pick<ModelUsage, "providerId" | "model">): string {
  return `${usage.providerId}:${usage.model ?? "default"}`;
}

/**
 * Live context-window size estimate: the most recent turn's input tokens when
 * available, otherwise the cumulative total. Used by auto-compaction to decide
 * when the running context has grown past the configured threshold.
 */
export function currentContextTokens(summary: UsageSummary): number {
  return summary.lastInputTokens ?? summary.totalTokens ?? 0;
}

function addModelUsage(
  byModel: Record<string, ModelUsageBreakdown> | undefined,
  usage: ModelUsage
): Record<string, ModelUsageBreakdown> {
  const key = modelUsageKey(usage);
  const existing = byModel?.[key];
  const merged: ModelUsageBreakdown = {
    providerId: usage.providerId,
    model: usage.model,
    inputTokens: addOptional(existing?.inputTokens, usage.inputTokens),
    outputTokens: addOptional(existing?.outputTokens, usage.outputTokens),
    totalTokens: addOptional(existing?.totalTokens, usage.totalTokens),
    cachedInputTokens: addOptional(existing?.cachedInputTokens, usage.cachedInputTokens),
    cacheWriteTokens: addOptional(existing?.cacheWriteTokens, usage.cacheWriteTokens),
    reasoningTokens: addOptional(existing?.reasoningTokens, usage.reasoningTokens),
    costUsd: addOptional(existing?.costUsd, usage.costUsd),
    turns: (existing?.turns ?? 0) + 1
  };
  return { ...(byModel ?? {}), [key]: merged };
}

export function usageHasValues(usage?: TokenUsage): boolean {
  return Boolean(usage && [usage.inputTokens, usage.outputTokens, usage.totalTokens, usage.cachedInputTokens, usage.cacheWriteTokens, usage.reasoningTokens].some((value) => typeof value === "number"));
}

export function normalizeUsage(raw: unknown, providerId: string, model?: string): ModelUsage | undefined {
  if (!isRecord(raw)) return undefined;
  const details = isRecord(raw.input_tokens_details) ? raw.input_tokens_details : isRecord(raw.prompt_tokens_details) ? raw.prompt_tokens_details : undefined;
  const outputDetails = isRecord(raw.output_tokens_details) ? raw.output_tokens_details : isRecord(raw.completion_tokens_details) ? raw.completion_tokens_details : undefined;
  // OpenAI-shaped `*_tokens_details.cached_tokens` is a subset of the reported
  // input tokens; Anthropic's `cache_read_input_tokens` is reported alongside
  // them. Record which one we read so cost accounting does not have to guess.
  const detailsCachedTokens = details ? numberField(details, "cached_tokens") : undefined;
  const cachedInputTokens = detailsCachedTokens ?? numberField(raw, "cache_read_input_tokens");
  const usage: ModelUsage = {
    providerId,
    model,
    inputTokens: numberField(raw, "input_tokens") ?? numberField(raw, "prompt_tokens"),
    outputTokens: numberField(raw, "output_tokens") ?? numberField(raw, "completion_tokens"),
    totalTokens: numberField(raw, "total_tokens"),
    cachedInputTokens,
    ...(cachedInputTokens === undefined ? {} : { cachedInputIncluded: detailsCachedTokens !== undefined }),
    cacheWriteTokens: numberField(raw, "cache_creation_input_tokens"),
    reasoningTokens: outputDetails ? numberField(outputDetails, "reasoning_tokens") : numberField(raw, "reasoning_tokens")
  };
  if (!usageHasValues(usage)) return undefined;
  if (usage.totalTokens === undefined && (usage.inputTokens !== undefined || usage.outputTokens !== undefined)) usage.totalTokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  return usage;
}

function addOptional(left?: number, right?: number): number | undefined {
  if (typeof left !== "number") return right;
  if (typeof right !== "number") return left;
  return left + right;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
