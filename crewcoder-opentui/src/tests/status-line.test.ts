import { createInitialState, type TuiEventBlock } from "@onpoint-dev-tools/crewcoder-tui-core/state/tui-store";
import stringWidth from "string-width";
import { describe, expect, it } from "vitest";
import { sessionName, splitGauge, statusLine, usageStatus } from "../status-line.js";

const prompt = (text: string): TuiEventBlock => ({ type: "user", text });

function state(overrides: Partial<ReturnType<typeof createInitialState>> = {}) {
  return { ...createInitialState(), provider: "claude", model: "opus", effort: "high" as const, sessionId: "session_2026-11-17T02-51-18-115Z_751hc1", blocks: [], ...overrides };
}

const full = (line: ReturnType<typeof statusLine>): string => `${line.access}${line.left}`;

describe("statusLine", () => {
  it("shows access, mode, provider/model (effort), and the session's name, never its raw id", () => {
    const line = statusLine(state({ gitRepo: "crewcoder", blocks: [prompt("fix the status line")] }), 120);
    expect(full(line)).toBe("Review · general · claude/opus (high) · crewcoder · fix the status line");
    expect(full(line)).not.toContain("session_");
    expect(line.right).toBe("");
  });

  it("marks Full Access", () => {
    expect(statusLine(state({ fullAccess: true }), 120).access).toBe("Full Access");
  });

  it("shows the worker only while worker identity is on", () => {
    expect(statusLine(state({ worker: "Builder", workerIdentityEnabled: true }), 120).left).toContain("worker Builder");
    expect(statusLine(state({ worker: "Builder", workerIdentityEnabled: false }), 120).left).toContain("general");
  });

  it("pins context usage and cost on the right", () => {
    const usage = { turns: 2, contextWindow: 200_000, lastInputTokens: 12_400, totalTokens: 15_000, costUsd: 0.034 };
    expect(statusLine(state({ usage }), 120).right).toBe("◔ 12.4k/200k - 6% | 15k tokens | $0.03");
  });

  it("shortens the chat name first and never exceeds the width", () => {
    const usage = { turns: 1, contextWindow: 200_000, lastInputTokens: 50_000, totalTokens: 50_000 };
    const blocks = [prompt("please refactor the entire provider registry and add tests for every adapter")];
    for (const width of [80, 50, 40, 20, 5, 0]) {
      const line = statusLine(state({ usage, gitRepo: "crewcoder", blocks }), width);
      const used = stringWidth(full(line)) + (line.right ? stringWidth(line.right) + 2 : 0);
      // Access always shows, even when it alone is wider than the terminal.
      expect(used, `width ${width}`).toBeLessThanOrEqual(Math.max(width, stringWidth(line.access)));
      expect(full(line).startsWith("Review")).toBe(true);
    }
    const narrow = statusLine(state({ usage, gitRepo: "crewcoder", blocks }), 110);
    expect(narrow.right).toBe("◑ 50k/200k - 25% | 50k tokens");
    expect(narrow.left).toContain("crewcoder · please");
    expect(narrow.left.endsWith("…")).toBe(true);
    // Very narrow: access first, then as much usage as fits; details drop out.
    expect(statusLine(state({ usage }), 20)).toEqual({ access: "Review", left: "", right: "◑ 50k/200k …" });
  });

  it("measures wide characters in a chat name as two cells", () => {
    const blocks = [prompt("修复状态栏里的会话名称显示问题 🚀🚀🚀")];
    for (const width of [60, 45, 41, 40]) {
      const line = statusLine(state({ blocks }), width);
      expect(stringWidth(full(line)), `width ${width}`).toBeLessThanOrEqual(width);
    }
  });
});

describe("sessionName", () => {
  it("is the repo and the first prompt, normalized to one line", () => {
    expect(sessionName({ gitRepo: "crewcoder", blocks: [prompt("  fix\nthe\r\n bug  "), prompt("later")] })).toBe("crewcoder · fix the bug");
  });

  it("falls back to whichever part exists, then to new session", () => {
    expect(sessionName({ gitRepo: "crewcoder", blocks: [] })).toBe("crewcoder");
    expect(sessionName({ gitRepo: undefined, blocks: [prompt("hello")] })).toBe("hello");
    expect(sessionName({ gitRepo: undefined, blocks: [{ type: "assistant", text: "hi" }] })).toBe("new session");
  });

  it("strips terminal control sequences from the prompt", () => {
    expect(sessionName({ gitRepo: undefined, blocks: [prompt("\x1b[31mred\x1b[0m title")] })).toBe("red title");
  });
});

describe("usageStatus", () => {
  it("is empty before any usage arrives, instead of ?/? placeholders", () => {
    expect(usageStatus({ turns: 0 })).toBe("");
    expect(usageStatus({ turns: 0, costUsd: 0.01 })).toBe("");
  });

  it("shows tokens without a known window, and a budget gauge when only a budget is set", () => {
    expect(usageStatus({ turns: 1, totalTokens: 1_234 })).toBe("1.2k tokens");
    expect(usageStatus({ turns: 0, tokenBudget: 100_000 })).toBe("○ 0/100k budget - 0% | 0 tokens");
  });
});

describe("splitGauge", () => {
  it("separates only a real gauge glyph", () => {
    expect(splitGauge("◔ 12k/200k - 6%")).toEqual({ gauge: "◔", rest: " 12k/200k - 6%" });
    expect(splitGauge("12.4k tokens")).toEqual({ gauge: "", rest: "12.4k tokens" });
    expect(splitGauge("")).toEqual({ gauge: "", rest: "" });
  });
});
