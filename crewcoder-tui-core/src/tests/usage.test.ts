import { describe, expect, it } from "vitest";
import { formatContextStatus } from "../state/usage.js";

describe("formatContextStatus", () => {
  it("renders context usage, percent, and total tokens when the window is known", () => {
    const status = formatContextStatus({ turns: 1, contextWindow: 200_000, lastInputTokens: 12_400, totalTokens: 12_400 });
    expect(status).toBe("◔ 12.4k/200k - 6% | 12.4k tokens");
  });

  it("picks a fuller glyph as the context fills", () => {
    expect(formatContextStatus({ turns: 1, contextWindow: 200_000, lastInputTokens: 190_000 })).toContain("●");
    expect(formatContextStatus({ turns: 1, contextWindow: 200_000, lastInputTokens: 120_000 })).toContain("◕");
  });

  it("clamps percent to 100 when context overflows the window", () => {
    const status = formatContextStatus({ turns: 1, contextWindow: 100_000, lastInputTokens: 250_000 });
    expect(status).toContain("- 100%");
  });

  it("falls back to a token summary when the context window is unknown", () => {
    expect(formatContextStatus({ turns: 1, totalTokens: 5_000 })).toBe("5k tokens");
  });

  it("renders a session token budget when context-window usage is unavailable", () => {
    expect(formatContextStatus({ turns: 2, totalTokens: 160_000, tokenBudget: 200_000 })).toBe("● 160k/200k budget - 80% | 160k tokens");
  });

  it("uses an unknown context shape on a fresh session with no usage yet", () => {
    expect(formatContextStatus({ turns: 0 })).toBe("?/? - ?% | ? tokens");
  });

  it("appends session spend in USD only when the backend priced the model", () => {
    expect(formatContextStatus({ turns: 1, contextWindow: 200_000, lastInputTokens: 12_400, totalTokens: 12_400, costUsd: 0.4231 })).toBe("◔ 12.4k/200k - 6% | 12.4k tokens | $0.42");
    expect(formatContextStatus({ turns: 1, totalTokens: 5_000, costUsd: 0.00042 })).toBe("5k tokens | $0.0004");
    expect(formatContextStatus({ turns: 1, totalTokens: 5_000 })).not.toContain("$");
  });
});
