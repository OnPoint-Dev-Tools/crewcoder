import { readConfig, type ModelPriceEntry } from "./config.js";
import { resolveOpenRouterPricing } from "../providers/openrouter-model-catalog.js";
import type { TokenUsage } from "./usage.js";

const MILLION = 1_000_000;

export type PricingSource = "config" | "openrouter";

/** USD per million tokens, the unit vendors publish prices in. */
export type ModelPricing = {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  /** Falls back to the input rate when a vendor does not price cache reads separately. */
  cacheReadPerMillionUsd?: number;
  /** Only Anthropic-style providers bill cache writes; omitted means "not billed". */
  cacheWritePerMillionUsd?: number;
  source: PricingSource;
};

export type CostBreakdown = {
  costUsd: number;
  uncachedInputUsd: number;
  cacheReadUsd: number;
  cacheWriteUsd: number;
  outputUsd: number;
};

/**
 * Config overrides win over the OpenRouter catalog, so a user on a discounted
 * or self-hosted endpoint can price their own traffic. Lookup order is
 * `provider:model`, then bare `model`, so one entry can cover every provider
 * serving the same model.
 */
export async function resolveModelPricing(providerId?: string, model?: string): Promise<ModelPricing | undefined> {
  const trimmedModel = model?.trim();
  if (!trimmedModel) return undefined;
  const configured = readConfiguredPricing(providerId?.trim(), trimmedModel);
  if (configured) return configured;

  const catalog = await resolveOpenRouterPricing(trimmedModel);
  if (!catalog) return undefined;
  return {
    inputPerMillionUsd: catalog.promptUsdPerToken * MILLION,
    outputPerMillionUsd: catalog.completionUsdPerToken * MILLION,
    ...(catalog.cacheReadUsdPerToken === undefined ? {} : { cacheReadPerMillionUsd: catalog.cacheReadUsdPerToken * MILLION }),
    ...(catalog.cacheWriteUsdPerToken === undefined ? {} : { cacheWritePerMillionUsd: catalog.cacheWriteUsdPerToken * MILLION }),
    source: "openrouter"
  };
}

/**
 * Cache accounting is provider-shaped, which is why `TokenUsage.cachedInputIncluded`
 * exists: OpenAI reports cached tokens *inside* `prompt_tokens`, Anthropic reports
 * `cache_read_input_tokens` *alongside* `input_tokens`. Getting this wrong either
 * double-bills the cache or hides it, so the flag is set where the field is read
 * rather than guessed from the numbers here.
 *
 * Reasoning tokens are already counted inside output tokens for every provider we
 * support, so they are reported but never billed a second time.
 */
export function computeCost(usage: TokenUsage, pricing: ModelPricing): CostBreakdown {
  const cacheRead = nonNegative(usage.cachedInputTokens);
  const cacheWrite = nonNegative(usage.cacheWriteTokens);
  const reportedInput = nonNegative(usage.inputTokens);
  const uncachedInput = usage.cachedInputIncluded ? Math.max(reportedInput - cacheRead, 0) : reportedInput;

  const uncachedInputUsd = rate(uncachedInput, pricing.inputPerMillionUsd);
  const cacheReadUsd = rate(cacheRead, pricing.cacheReadPerMillionUsd ?? pricing.inputPerMillionUsd);
  const cacheWriteUsd = pricing.cacheWritePerMillionUsd === undefined ? 0 : rate(cacheWrite, pricing.cacheWritePerMillionUsd);
  const outputUsd = rate(nonNegative(usage.outputTokens), pricing.outputPerMillionUsd);

  return {
    costUsd: uncachedInputUsd + cacheReadUsd + cacheWriteUsd + outputUsd,
    uncachedInputUsd,
    cacheReadUsd,
    cacheWriteUsd,
    outputUsd
  };
}

export function formatUsd(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  if (value === 0) return "$0.00";
  if (Math.abs(value) < 0.01) return `$${value.toFixed(6)}`;
  if (Math.abs(value) < 1) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

function readConfiguredPricing(providerId: string | undefined, model: string): ModelPricing | undefined {
  const table = readConfig().modelPricing;
  const entry = (providerId ? table[`${providerId}:${model}`] : undefined) ?? table[model];
  if (!entry) return undefined;
  return toConfigPricing(entry);
}

function toConfigPricing(entry: ModelPriceEntry): ModelPricing {
  return {
    inputPerMillionUsd: entry.inputPerMillionUsd,
    outputPerMillionUsd: entry.outputPerMillionUsd,
    ...(entry.cacheReadPerMillionUsd === undefined ? {} : { cacheReadPerMillionUsd: entry.cacheReadPerMillionUsd }),
    ...(entry.cacheWritePerMillionUsd === undefined ? {} : { cacheWritePerMillionUsd: entry.cacheWritePerMillionUsd }),
    source: "config"
  };
}

function rate(tokens: number, perMillionUsd: number): number {
  return (tokens / MILLION) * perMillionUsd;
}

function nonNegative(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
