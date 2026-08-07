import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.hoisted(() => vi.fn());
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: queryMock,
  tool: (name: string, description: string, inputSchema: unknown, handler: unknown) => ({ name, description, inputSchema, handler }),
  createSdkMcpServer: (options: unknown) => ({ type: "sdk", name: "crewcoder", instance: {}, options })
}));

import { runClaudeAgentSdkProvider } from "../providers/claude-agent-sdk-provider.js";
import type { ProviderDefinition } from "../providers/types.js";

const provider: ProviderDefinition = { id: "claude", title: "Claude SDK", kind: "builtin", runtime: "claude-agent-sdk", command: "sdk", args: [] };

beforeEach(() => queryMock.mockReset());

describe("Claude Agent SDK provider", () => {
  it("uses project context, hybrid native tools, and CrewCoder MCP execution", async () => {
    queryMock.mockImplementation((request?: { options?: unknown }) => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "system", subtype: "init", session_id: "claude-session-1", model: "claude-sonnet-5" };
        yield { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking" } } };
        yield { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "checking" } } };
        yield { type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "text" } } };
        yield { type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "done" } } };
        yield { type: "result", subtype: "success", usage: { input_tokens: 8, output_tokens: 2 } };
      },
      options: request?.options,
      async getContextUsage() { return { totalTokens: 42 }; }
    }));
    const executeTool = vi.fn(async (call) => ({ role: "toolResult" as const, toolCallId: call.id, toolName: call.name, content: [{ type: "text" as const, text: "command ok" }], isError: false, timestamp: Date.now() }));
    const sessions: string[] = [];
    const thinking: string[] = [];

    const result = await runClaudeAgentSdkProvider({
      provider,
      prompt: "work",
      cwd: "/repo",
      model: "claude-sonnet-5",
      modelInput: {
        systemPrompt: "CrewCoder system",
        externalDirectories: ["/shared"],
        messages: [{ role: "user", content: [{ type: "text", text: "work" }], timestamp: Date.now() }],
        availableTools: [
          { name: "read", description: "Read", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
          { name: "bash", description: "Run", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } }
        ],
        session: { sessionId: "crew-session", continuation: false }
      },
      stream: { executeTool, onProviderSessionId: (id) => { sessions.push(id); }, onThinkingDelta: (text) => { thinking.push(text); } }
    });

    const options = queryMock.mock.calls[0][0].options;
    expect(options.settingSources).toEqual(["project"]);
    expect(options.skills).toEqual([]);
    expect(options.tools).toEqual(["Read", "Grep", "Glob", "AskUserQuestion"]);
    expect(options.additionalDirectories).toEqual(["/shared"]);
    expect(options.systemPrompt).toMatchObject({ preset: "claude_code", append: "CrewCoder system" });
    expect(options.strictMcpConfig).toBe(true);
    expect(options.settings.autoCompactEnabled).toBe(true);
    const mcpOptions = options.mcpServers.crewcoder.options;
    expect(mcpOptions.tools.map((entry: { name: string }) => entry.name)).toEqual(["bash"]);
    await mcpOptions.tools[0].handler({ command: "pwd" });
    expect(executeTool).toHaveBeenCalledWith(expect.objectContaining({ name: "bash", arguments: { command: "pwd" } }));
    expect(sessions).toEqual(["claude-session-1"]);
    expect(thinking).toEqual(["checking"]);
    expect(result.usage).toMatchObject({ inputTokens: 8, outputTokens: 2, contextTokens: 42 });
    expect(JSON.parse(result.text).content).toEqual([{ type: "text", text: "done" }]);
  });

  it("resumes the persisted Claude-native session and routes questions", async () => {
    queryMock.mockImplementation(() => ({ async *[Symbol.asyncIterator]() { yield { type: "result", subtype: "success", result: "ok" }; } }));
    const requestQuestion = vi.fn(async () => "Safe");
    await runClaudeAgentSdkProvider({
      provider,
      prompt: "continue",
      cwd: "/repo",
      reasoningEffort: "high",
      modelInput: {
        systemPrompt: "system",
        messages: [{ role: "user", content: [{ type: "text", text: "continue" }], timestamp: Date.now() }],
        availableTools: [],
        session: { sessionId: "crew-session", providerSessionId: "claude-native", continuation: true }
      },
      stream: { executeTool: vi.fn(), requestQuestion }
    });
    const options = queryMock.mock.calls[0][0].options;
    expect(options.resume).toBe("claude-native");
    expect(options.thinking).toEqual({ type: "adaptive" });
    expect(options.effort).toBe("high");
    const decision = await options.canUseTool("AskUserQuestion", { questions: [{ question: "Approach?", options: [{ label: "Safe" }] }] });
    expect(decision).toMatchObject({ behavior: "allow", updatedInput: { answers: { "Approach?": "Safe" } } });
  });

  it("forwards completed thinking blocks when partial events are unavailable", async () => {
    queryMock.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "assistant", message: { content: [{ type: "thinking", thinking: "full reasoning" }, { type: "text", text: "answer" }] } };
        yield { type: "result", subtype: "success", result: "answer" };
      }
    }));
    const thinking: string[] = [];
    await runClaudeAgentSdkProvider({
      provider, prompt: "work", cwd: "/repo", reasoningEffort: "medium",
      modelInput: { systemPrompt: "system", messages: [{ role: "user", content: [{ type: "text", text: "work" }], timestamp: Date.now() }], availableTools: [], session: { sessionId: "crew", continuation: false } },
      stream: { executeTool: vi.fn(), onThinkingDelta: (text) => { thinking.push(text); } }
    });
    expect(thinking).toEqual(["full reasoning"]);
  });

  it("does not duplicate a completed thinking block after partial deltas", async () => {
    queryMock.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking" } } };
        yield { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "full " } } };
        yield { type: "assistant", message: { content: [{ type: "thinking", thinking: "full reasoning" }] } };
        yield { type: "result", subtype: "success", result: "answer" };
      }
    }));
    const thinking: string[] = [];
    await runClaudeAgentSdkProvider({
      provider, prompt: "work", cwd: "/repo", reasoningEffort: "high",
      modelInput: { systemPrompt: "system", messages: [{ role: "user", content: [{ type: "text", text: "work" }], timestamp: Date.now() }], availableTools: [], session: { sessionId: "crew", continuation: false } },
      stream: { executeTool: vi.fn(), onThinkingDelta: (text) => { thinking.push(text); } }
    });
    expect(thinking).toEqual(["full ", "reasoning"]);
  });

  it("hands existing CrewCoder history to a new Claude-native session", async () => {
    queryMock.mockImplementation(() => ({ async *[Symbol.asyncIterator]() { yield { type: "result", subtype: "success", result: "continued" }; } }));
    await runClaudeAgentSdkProvider({
      provider, prompt: "latest", cwd: "/repo",
      modelInput: {
        systemPrompt: "system",
        messages: [
          { role: "user", content: [{ type: "text", text: "earlier request" }], timestamp: 1 },
          { role: "assistant", content: [{ type: "text", text: "earlier answer" }], stopReason: "end", timestamp: 2 },
          { role: "user", content: [{ type: "text", text: "latest" }], timestamp: 3 }
        ],
        availableTools: [],
        session: { sessionId: "crew", continuation: true }
      },
      stream: { executeTool: vi.fn() }
    });
    expect(queryMock.mock.calls[0][0].prompt).toContain(JSON.stringify({ role: "assistant", content: [{ type: "text", text: "earlier answer" }] }));
    expect(queryMock.mock.calls[0][0].prompt).toContain(JSON.stringify({ role: "user", text: "latest" }));
  });

  it("routes file tools through CrewCoder MCP when a virtual file host is active", async () => {
    queryMock.mockImplementation(() => ({ async *[Symbol.asyncIterator]() { yield { type: "result", subtype: "success", result: "ok" }; } }));
    await runClaudeAgentSdkProvider({
      provider, prompt: "read", cwd: "/remote",
      modelInput: {
        systemPrompt: "system",
        messages: [{ role: "user", content: [{ type: "text", text: "read" }], timestamp: Date.now() }],
        useProviderNativeFileTools: false,
        availableTools: [
          { name: "read", description: "Read through host", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
          { name: "grep", description: "Search through host", parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] } }
        ],
        session: { sessionId: "crew", continuation: false }
      },
      stream: { executeTool: vi.fn() }
    });
    const options = queryMock.mock.calls[0][0].options;
    expect(options.tools).toEqual(["AskUserQuestion"]);
    expect(options.mcpServers.crewcoder.options.tools.map((entry: { name: string }) => entry.name)).toEqual(["read", "grep"]);
  });

  it("preserves actionable SDK result errors", async () => {
    queryMock.mockImplementation(() => ({ async *[Symbol.asyncIterator]() { yield { type: "result", subtype: "error_during_execution", errors: ["authentication expired"] }; } }));
    const result = await runClaudeAgentSdkProvider({
      provider, prompt: "work", cwd: "/repo",
      modelInput: { systemPrompt: "system", messages: [{ role: "user", content: [{ type: "text", text: "work" }], timestamp: Date.now() }], availableTools: [], session: { sessionId: "crew", continuation: false } },
      stream: { executeTool: vi.fn() }
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("authentication expired");
    expect(JSON.parse(result.text).errorMessage).toBe("authentication expired");
  });

  it("projects native read tool activity without duplicating MCP execution", async () => {
    queryMock.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "read-1", name: "Read", input: {} } } };
        yield { type: "assistant", message: { content: [{ type: "tool_use", id: "read-1", name: "Read", input: { file_path: "README.md" } }] } };
        yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "read-1", content: "contents" }] } };
        yield { type: "result", subtype: "success", result: "done" };
      }
    }));
    const starts: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const ends: string[] = [];
    await runClaudeAgentSdkProvider({
      provider, prompt: "read", cwd: "/repo",
      modelInput: { systemPrompt: "system", messages: [{ role: "user", content: [{ type: "text", text: "read" }], timestamp: Date.now() }], availableTools: [], session: { sessionId: "crew", continuation: false } },
      stream: { executeTool: vi.fn(), onProviderToolStart: (call) => { starts.push({ name: call.name, arguments: call.arguments }); }, onProviderToolEnd: (result) => { ends.push(result.toolName); } }
    });
    expect(starts).toEqual([{ name: "Read", arguments: { file_path: "README.md" } }]);
    expect(ends).toEqual(["Read"]);
  });
});
