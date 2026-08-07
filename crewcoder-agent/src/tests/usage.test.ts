import { describe, expect, it } from "vitest";
import { addUsage, currentContextTokens, emptyUsageSummary, normalizeUsage } from "../core/usage.js";

describe("usage accounting", () => {
  it("normalizes OpenAI-style usage details", () => {
    const usage = normalizeUsage({
      input_tokens: 100,
      output_tokens: 40,
      total_tokens: 140,
      input_tokens_details: { cached_tokens: 25 },
      output_tokens_details: { reasoning_tokens: 10 }
    }, "openai", "gpt-test");

    expect(usage).toMatchObject({
      providerId: "openai",
      model: "gpt-test",
      inputTokens: 100,
      outputTokens: 40,
      totalTokens: 140,
      cachedInputTokens: 25,
      reasoningTokens: 10
    });
  });

  it("parses Anthropic cache read/write tokens and accumulates the write total", () => {
    const usage = normalizeUsage({
      input_tokens: 300,
      output_tokens: 50,
      cache_read_input_tokens: 120,
      cache_creation_input_tokens: 80
    }, "anthropic", "claude-test");

    expect(usage).toMatchObject({ cachedInputTokens: 120, cacheWriteTokens: 80 });

    let summary = emptyUsageSummary();
    summary = addUsage(summary, usage!);
    summary = addUsage(summary, { providerId: "anthropic", model: "claude-test", cacheWriteTokens: 20 });
    expect(summary.cacheWriteTokens).toBe(100);
    expect(summary.byModel?.["anthropic:claude-test"]).toMatchObject({ cacheWriteTokens: 100 });
  });

  it("tracks per-model breakdown, replaced last-input tokens, and live context size", () => {
    let summary = emptyUsageSummary();
    summary = addUsage(summary, { providerId: "openai", model: "gpt-a", inputTokens: 100, outputTokens: 10, totalTokens: 110 });
    summary = addUsage(summary, { providerId: "openai", model: "gpt-a", inputTokens: 250, outputTokens: 20, totalTokens: 270 });
    summary = addUsage(summary, { providerId: "anthropic", model: "claude-b", inputTokens: 80, outputTokens: 5, totalTokens: 85, contextTokens: 95 });

    // Cumulative fields sum; lastInputTokens is replaced with the most recent turn.
    expect(summary.totalTokens).toBe(465);
    expect(summary.lastInputTokens).toBe(95);
    expect(summary.turns).toBe(3);

    // Live context tracks the most recent input, not the lifetime total.
    expect(currentContextTokens(summary)).toBe(95);

    const openai = summary.byModel?.["openai:gpt-a"];
    expect(openai).toMatchObject({ inputTokens: 350, outputTokens: 30, totalTokens: 380, turns: 2 });
    expect(summary.byModel?.["anthropic:claude-b"]).toMatchObject({ inputTokens: 80, turns: 1 });
  });

  it("falls back to cumulative total when no turn has reported input tokens", () => {
    const summary = { ...emptyUsageSummary(), totalTokens: 4200 };
    expect(currentContextTokens(summary)).toBe(4200);
    expect(currentContextTokens(emptyUsageSummary())).toBe(0);
  });
});
