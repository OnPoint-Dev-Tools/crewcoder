import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCostLedgerPath, readCostLedger, recordModelUsageCost, summarizeCosts, type CostLedgerEntry } from "../core/cost-ledger.js";
import { computeCost, formatUsd, resolveModelPricing } from "../core/model-pricing.js";
import { readConfig, writeConfig } from "../core/config.js";
import { normalizeUsage } from "../core/usage.js";

const temporaryHomes: string[] = [];

async function createHome(): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "crewcoder-cost-.crewcoder"));
  temporaryHomes.push(home);
  vi.stubEnv("CREWCODER_HOME", home);
  return home;
}

function priceModel(key: string, entry: { inputPerMillionUsd: number; outputPerMillionUsd: number; cacheReadPerMillionUsd?: number; cacheWritePerMillionUsd?: number }): void {
  const current = readConfig();
  writeConfig({ ...current, modelPricing: { ...current.modelPricing, [key]: entry } });
}

describe("cost ledger", () => {
  beforeEach(async () => {
    await createHome();
    // No network in tests: the OpenRouter catalog must never be reached.
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network disabled in tests"); }));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await Promise.all(temporaryHomes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })));
  });

  it("prices a turn from config overrides and records full token usage", async () => {
    priceModel("codex:gpt-test", { inputPerMillionUsd: 3, outputPerMillionUsd: 15, cacheReadPerMillionUsd: 0.3, cacheWritePerMillionUsd: 3.75 });

    const { entry, error } = await recordModelUsageCost(
      { providerId: "codex", model: "gpt-test", inputTokens: 1_000_000, outputTokens: 100_000, cachedInputTokens: 500_000, cachedInputIncluded: true, cacheWriteTokens: 200_000, reasoningTokens: 40_000, totalTokens: 1_100_000 },
      { sessionId: "s-1", worker: "Crew", cwd: "/repo" }
    );

    expect(error).toBeUndefined();
    // 0.5M uncached in ($1.50) + 0.5M cache read ($0.15) + 0.2M cache write ($0.75) + 0.1M out ($1.50)
    expect(entry?.costUsd).toBeCloseTo(3.9, 10);
    expect(entry?.pricingSource).toBe("config");
    expect(entry?.reasoningTokens).toBe(40_000);

    const persisted = await readCostLedger();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.sessionId).toBe("s-1");
    expect(persisted[0]?.worker).toBe("Crew");
    expect(getCostLedgerPath()).toContain("cost.jsonl");
  });

  it("records tokens without a cost when the model has no known price", async () => {
    const { entry } = await recordModelUsageCost({ providerId: "mystery", model: "unpriced", inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(entry?.costUsd).toBeUndefined();
    expect(entry?.totalTokens).toBe(15);

    const report = summarizeCosts(await readCostLedger(), "model");
    expect(report.total.costUsd).toBe(0);
    expect(report.total.unpricedTurns).toBe(1);
  });

  it("records provider-reported cost when no model rate is configured", async () => {
    const { entry } = await recordModelUsageCost({ providerId: "claude", model: "subscription", inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0.0123 });
    expect(entry?.costUsd).toBe(0.0123);
    expect(summarizeCosts(await readCostLedger(), "provider").total.unpricedTurns).toBe(0);
  });

  it("prefers a provider-scoped override over a bare model override", async () => {
    priceModel("shared-model", { inputPerMillionUsd: 1, outputPerMillionUsd: 1 });
    priceModel("codex:shared-model", { inputPerMillionUsd: 10, outputPerMillionUsd: 10 });

    await expect(resolveModelPricing("codex", "shared-model")).resolves.toMatchObject({ inputPerMillionUsd: 10 });
    await expect(resolveModelPricing("opencode", "shared-model")).resolves.toMatchObject({ inputPerMillionUsd: 1 });
  });

  it("does not double-bill cache reads that are already inside the reported input tokens", () => {
    const pricing = { inputPerMillionUsd: 10, outputPerMillionUsd: 0, cacheReadPerMillionUsd: 1, source: "config" as const };
    const included = computeCost({ inputTokens: 1_000_000, cachedInputTokens: 900_000, cachedInputIncluded: true }, pricing);
    const separate = computeCost({ inputTokens: 1_000_000, cachedInputTokens: 900_000, cachedInputIncluded: false }, pricing);

    expect(included.costUsd).toBeCloseTo(1 + 0.9, 10);
    expect(separate.costUsd).toBeCloseTo(10 + 0.9, 10);
  });

  it("tags OpenAI-style cached tokens as included and Anthropic-style as separate", () => {
    const openai = normalizeUsage({ prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 60 } }, "codex", "gpt-test");
    const anthropic = normalizeUsage({ input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: 50 }, "opencode", "claude-test");

    expect(openai?.cachedInputIncluded).toBe(true);
    expect(anthropic?.cachedInputIncluded).toBe(false);
    expect(anthropic?.cacheWriteTokens).toBe(50);
  });

  it("groups by model, worker, session, and day and filters by time", async () => {
    const entries: CostLedgerEntry[] = [
      { timestamp: "2026-07-01T10:00:00.000Z", providerId: "codex", model: "a", sessionId: "s1", worker: "Crew", inputTokens: 10, outputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 11, costUsd: 1 },
      { timestamp: "2026-07-02T10:00:00.000Z", providerId: "codex", model: "b", sessionId: "s2", worker: "Reviewer", inputTokens: 20, outputTokens: 2, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 5, totalTokens: 22, costUsd: 2 }
    ];
    await fs.mkdir(path.dirname(getCostLedgerPath()), { recursive: true });
    await fs.writeFile(getCostLedgerPath(), entries.map((entry) => JSON.stringify(entry)).join("\n") + "\nnot json\n", "utf8");

    const all = await readCostLedger();
    expect(all).toHaveLength(2);
    expect(summarizeCosts(all, "model").groups.map((group) => group.key)).toEqual(["codex:b", "codex:a"]);
    expect(summarizeCosts(all, "worker").groups.map((group) => group.key)).toEqual(["Reviewer", "Crew"]);
    expect(summarizeCosts(all, "day").groups.map((group) => group.key)).toEqual(["2026-07-02", "2026-07-01"]);
    expect(summarizeCosts(all, "session").total.costUsd).toBe(3);
    expect(summarizeCosts(all, "model").total.reasoningTokens).toBe(5);

    const recent = await readCostLedger({ since: new Date("2026-07-02T00:00:00.000Z") });
    expect(recent.map((entry) => entry.model)).toEqual(["b"]);
    expect((await readCostLedger({ worker: "crew" })).map((entry) => entry.model)).toEqual(["a"]);
    expect((await readCostLedger({ sessionId: "s2" })).map((entry) => entry.model)).toEqual(["b"]);
  });

  it("formats sub-cent spend without rounding it to zero", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.000123)).toBe("$0.000123");
    expect(formatUsd(0.5)).toBe("$0.5000");
    expect(formatUsd(12.345)).toBe("$12.35");
    expect(formatUsd(undefined)).toBe("-");
  });
});
