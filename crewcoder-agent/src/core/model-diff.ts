import { getText, textMessage } from "./messages.js";
import type { ModelClient } from "./model-client.js";
import { computeCost, resolveModelPricing, type PricingSource } from "./model-pricing.js";
import type { ModelUsage, TokenUsage } from "./usage.js";

/** One model to race: a provider plus an optional model id (undefined = provider default). */
export type ModelCandidate = {
  providerId: string;
  model?: string;
  /** Stable display key, `provider:model`. Also the JSON group key. */
  label: string;
};

export type ModelDiffResult = {
  candidate: ModelCandidate;
  ok: boolean;
  /** The model's reply. Empty when the call failed. */
  text: string;
  /** Set only when `ok` is false. */
  errorMessage?: string;
  /** Wall-clock time for this candidate's single model call. */
  latencyMs: number;
  usage?: TokenUsage;
  /** Absent when no rate is known for the model — unpriced is not free. */
  costUsd?: number;
  pricingSource?: PricingSource;
};

export type ModelDiffReport = {
  prompt: string;
  startedAt: string;
  /** Wall-clock time for the whole comparison, which is < the sum when run concurrently. */
  totalMs: number;
  concurrent: boolean;
  results: ModelDiffResult[];
};

export type ModelDiffOptions = {
  prompt: string;
  candidates: ModelCandidate[];
  /** Built per candidate so each gets its own provider/model/debug wiring. */
  createModelClient: (candidate: ModelCandidate) => ModelClient;
  /** Optional shared system prompt; defaults to a neutral one-shot instruction. */
  systemPrompt?: string;
  /** Run candidates in parallel (default) or one at a time for cleaner latency numbers. */
  concurrent?: boolean;
  signal?: AbortSignal;
};

const DEFAULT_SYSTEM_PROMPT = [
  "You are being evaluated side by side against other models on a single prompt.",
  "Answer the prompt directly and completely in one response.",
  "You have no tools available, so do not request tools and do not claim to have run anything."
].join("\n");

export function candidateLabel(providerId: string, model?: string): string {
  return `${providerId}:${model ?? "default"}`;
}

/**
 * Parse `--models` specs into candidates. A spec is `provider:model`, a bare
 * provider id, or a bare model id that runs on `defaultProviderId`.
 *
 * The `provider:` prefix is only honored when the left side is a *known*
 * provider id, because model ids legitimately contain colons (`qwen-2.5:free`).
 * Guessing from the punctuation would silently route a real model to a
 * nonexistent provider.
 */
export function parseModelSpecs(
  specs: string[],
  context: { knownProviderIds: string[]; defaultProviderId: string }
): ModelCandidate[] {
  const known = new Set(context.knownProviderIds);
  const candidates: ModelCandidate[] = [];
  const seen = new Set<string>();
  for (const raw of specs.flatMap((spec) => spec.split(",")).map((spec) => spec.trim()).filter(Boolean)) {
    const separator = raw.indexOf(":");
    const head = separator === -1 ? raw : raw.slice(0, separator);
    const tail = separator === -1 ? "" : raw.slice(separator + 1).trim();
    const isProviderPrefixed = separator !== -1 && known.has(head);
    const providerId = isProviderPrefixed ? head : known.has(raw) ? raw : context.defaultProviderId;
    const model = isProviderPrefixed ? tail || undefined : known.has(raw) ? undefined : raw;
    const label = candidateLabel(providerId, model);
    if (seen.has(label)) continue;
    seen.add(label);
    candidates.push({ providerId, ...(model ? { model } : {}), label });
  }
  return candidates;
}

/**
 * Run the same prompt against every candidate and report response, latency, and
 * cost. Each call is one-shot with `availableTools: []` and writes no session —
 * this is a comparison harness, not an agent run. A candidate that fails is
 * recorded as a failed result so one dead provider never hides the others.
 */
export async function diffModels(options: ModelDiffOptions): Promise<ModelDiffReport> {
  const concurrent = options.concurrent !== false;
  const startedAt = new Date();
  const started = Date.now();
  const run = (candidate: ModelCandidate) => runCandidate(candidate, options);
  const results = concurrent
    ? await Promise.all(options.candidates.map(run))
    : await runSequentially(options.candidates, run);
  return {
    prompt: options.prompt,
    startedAt: startedAt.toISOString(),
    totalMs: Date.now() - started,
    concurrent,
    results
  };
}

/** Deterministic single-line comparison rows, shared by the CLI table and tests. */
export function formatDiffRow(result: ModelDiffResult): string {
  const status = result.ok ? "ok" : "failed";
  const tokens = result.usage?.totalTokens ?? 0;
  return `${result.candidate.label} ${status} ${result.latencyMs}ms ${tokens} tokens`;
}

async function runSequentially(
  candidates: ModelCandidate[],
  run: (candidate: ModelCandidate) => Promise<ModelDiffResult>
): Promise<ModelDiffResult[]> {
  const results: ModelDiffResult[] = [];
  for (const candidate of candidates) results.push(await run(candidate));
  return results;
}

async function runCandidate(candidate: ModelCandidate, options: ModelDiffOptions): Promise<ModelDiffResult> {
  const started = Date.now();
  let usage: ModelUsage | undefined;
  try {
    const client = options.createModelClient(candidate);
    const assistant = await client.complete(
      {
        systemPrompt: options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
        messages: [textMessage("user", options.prompt)],
        availableTools: []
      },
      options.signal,
      {
        onUsage(reported) {
          usage = reported;
        }
      }
    );
    const latencyMs = Date.now() - started;
    // Provider failures arrive as an error-stopReason message, not a throw.
    if (assistant.stopReason === "error") {
      return {
        candidate,
        ok: false,
        text: "",
        errorMessage: assistant.errorMessage?.trim() || "The provider returned an error.",
        latencyMs,
        ...(await priced(candidate, usage))
      };
    }
    return { candidate, ok: true, text: getText(assistant).trim(), latencyMs, ...(await priced(candidate, usage)) };
  } catch (error) {
    return {
      candidate,
      ok: false,
      text: "",
      errorMessage: error instanceof Error ? error.message : String(error),
      latencyMs: Date.now() - started,
      ...(await priced(candidate, usage))
    };
  }
}

/**
 * Pricing is best-effort: an unknown rate leaves `costUsd` absent rather than
 * reporting $0.00, and a pricing lookup failure never fails the comparison.
 */
async function priced(
  candidate: ModelCandidate,
  usage: ModelUsage | undefined
): Promise<Pick<ModelDiffResult, "usage" | "costUsd" | "pricingSource">> {
  if (!usage) return {};
  const tokens: TokenUsage = {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    cachedInputTokens: usage.cachedInputTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    reasoningTokens: usage.reasoningTokens,
    cachedInputIncluded: usage.cachedInputIncluded
  };
  try {
    const pricing = await resolveModelPricing(candidate.providerId, usage.model ?? candidate.model);
    if (!pricing) return { usage: tokens };
    const costUsd = computeCost(usage, pricing).costUsd;
    return { usage: { ...tokens, costUsd }, costUsd, pricingSource: pricing.source };
  } catch {
    return { usage: tokens };
  }
}
