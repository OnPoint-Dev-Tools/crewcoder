import { beforeEach, describe, expect, it, vi } from "vitest";
import { addUsage, emptyUsageSummary } from "../crewcoder-agent/src/core/usage.js";

const queryMock = vi.hoisted(() => vi.fn());
vi.mock("../crewcoder-agent/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs", () => ({
  query: queryMock,
  tool: vi.fn(),
  createSdkMcpServer: vi.fn()
}));

import { runClaudeAgentSdkProvider } from "../crewcoder-agent/src/providers/claude-agent-sdk-provider.js";

const run = () => runClaudeAgentSdkProvider({
  provider: { id: "claude", title: "Claude", kind: "builtin", runtime: "claude-agent-sdk", command: "sdk", args: [] },
  prompt: "continue", cwd: "/repo", model: "sonnet",
  modelInput: { systemPrompt: "system", messages: [], availableTools: [] },
  stream: { executeTool: vi.fn() }
});

const assistant = (input: number, read: number, write: number, parent: string | null = null) => ({
  type: "assistant", parent_tool_use_id: parent,
  message: { model: "claude-sonnet-test", content: [], usage: { input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: 90 } }
});
const result = {
  type: "result", subtype: "success", result: "done",
  usage: { input_tokens: 2, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 48_990, output_tokens: 300 },
  modelUsage: {
    "claude-sonnet-test": { contextWindow: 1_000_000 },
    "claude-haiku-test": { contextWindow: 200_000 }
  }
};

beforeEach(() => queryMock.mockReset());

describe("Claude context snapshots", () => {
  it.each(["missing", "closed"])("counts cached context when the native query is %s", async (mode) => {
    queryMock.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield assistant(1, 0, 40_000);
        yield assistant(2, 40_000, 8_990);
        yield assistant(1, 190_000, 0, "subagent-tool");
        yield result;
      },
      ...(mode === "closed" ? { getContextUsage: async () => { throw new Error("Query closed before response received"); } } : {})
    });
    const response = await run();
    expect(response.usage).toMatchObject({ contextTokens: 48_992, contextWindow: 1_000_000, inputTokens: 2, cachedInputTokens: 100_000, cacheWriteTokens: 48_990, outputTokens: 300 });
    expect(addUsage(emptyUsageSummary(), response.usage).lastInputTokens).toBe(48_992);
  });

  it("prefers native occupancy and effective capacity over request and catalog values", async () => {
    queryMock.mockReturnValue({
      async *[Symbol.asyncIterator]() { yield assistant(2, 40_000, 8_990); yield result; },
      getContextUsage: async () => ({ totalTokens: 51_000, maxTokens: 180_000, rawMaxTokens: 200_000 })
    });
    expect((await run()).usage).toMatchObject({ contextTokens: 51_000, contextWindow: 180_000 });
  });

  it.each([NaN, Infinity, -1])("rejects an invalid native count or capacity: %s", async (invalid) => {
    queryMock.mockReturnValue({
      async *[Symbol.asyncIterator]() { yield assistant(2, 40_000, 8_990); yield result; },
      getContextUsage: async () => ({ totalTokens: invalid, maxTokens: invalid })
    });
    expect((await run()).usage).toMatchObject({ contextTokens: 48_992, contextWindow: 1_000_000 });
  });

  it("replaces a larger request count after compaction and preserves zero uncached input", async () => {
    queryMock.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield assistant(2, 900_000, 0);
        yield { type: "system", subtype: "compact_boundary" };
        yield assistant(0, 0, 20_000);
        yield result;
      }
    });
    expect((await run()).usage?.contextTokens).toBe(20_000);
  });

  it("does not treat aggregate billing or another model's capacity as a context snapshot", async () => {
    queryMock.mockReturnValue({ async *[Symbol.asyncIterator]() { yield result; } });
    const response = await run();
    expect(response.usage?.contextTokens).toBeUndefined();
    expect(response.usage?.contextWindow).toBeUndefined();
  });
});
