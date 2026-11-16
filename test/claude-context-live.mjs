import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runClaudeAgentSdkProvider } from "../crewcoder-agent/dist/providers/claude-agent-sdk-provider.js";
import { addUsage, emptyUsageSummary } from "../crewcoder-agent/dist/core/usage.js";

// Explicit opt-in: this sends one small request using the local Claude login.
assert.equal(process.env.CREWCODER_LIVE_CONTEXT, "1", "Set CREWCODER_LIVE_CONTEXT=1 to run the live check");
const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "crewcoder-context-live-"));
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 45_000);
try {
  const response = await runClaudeAgentSdkProvider({
    provider: { id: "claude", title: "Claude", kind: "builtin", runtime: "claude-agent-sdk", command: "sdk", args: [] },
    model: "sonnet", cwd, prompt: "Reply with OK only. Do not use tools.", reasoningEffort: "off",
    modelInput: {
      systemPrompt: "Reply briefly. Do not use tools.",
      messages: [{ role: "user", content: [{ type: "text", text: "Reply with OK only. Do not use tools." }], timestamp: Date.now() }],
      availableTools: [], useProviderNativeFileTools: false, approvalMode: "never"
    },
    stream: { executeTool: async () => { throw new Error("No tools allowed in this check"); } }
  }, controller.signal);
  assert.equal(response.exitCode, 0, response.stderr);
  const usage = response.usage;
  assert.ok(usage?.contextTokens > 0, "Expected a positive context snapshot");
  assert.ok(usage?.contextWindow > 0, "Expected runtime context capacity");
  const summary = addUsage(emptyUsageSummary(), usage);
  assert.equal(summary.lastInputTokens, usage.contextTokens);
  console.log(JSON.stringify({ contextTokens: usage.contextTokens, contextWindow: usage.contextWindow, inputTokens: usage.inputTokens, cachedInputTokens: usage.cachedInputTokens, cacheWriteTokens: usage.cacheWriteTokens, percent: 100 * usage.contextTokens / usage.contextWindow }));
} finally {
  clearTimeout(timeout);
}
