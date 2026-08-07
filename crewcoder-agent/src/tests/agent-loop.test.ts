import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assistantText, getText, textMessage, type AgentMessage } from "../core/messages.js";
import { runAgentLoop } from "../core/agent-loop.js";
import { clearCrewCoderExtensionRuntimeCache } from "../extensions/extension-runtime.js";
import type { AgentEvent } from "../core/events.js";
import { runAgentLoopContinue } from "../core/agent-loop-continue.js";
import { saveSession } from "../core/session-store.js";
import { loadSession } from "../core/session-loader.js";
import { readConfig, writeConfig } from "../core/config.js";
import { saveSystemPrompt } from "../core/system-prompt-store.js";
import type { ModelClient } from "../core/model-client.js";
import type { ToolDefinition } from "../core/tool-types.js";
import { readAuditLog } from "../core/audit-log.js";
import { readCostLedger } from "../core/cost-ledger.js";

describe("agent loop", () => {
  it("runs plugin mode, executes createPlugin, and records mutations", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-loop-"));
    const result = await runAgentLoop({ prompt: "create a CrewCode plugin named repo-radar-test", requestedMode: "plugin", cwd }, { maxIterations: 2, integrationProfile: "crewcode" });
    expect(result.mode).toBe("plugin");
    expect(fs.existsSync(path.join(cwd, "repo-radar-test", "crewcode.plugin.json"))).toBe(true);
    expect(result.mutationLog.some((file) => file.includes("crewcode.plugin.json"))).toBe(true);
  });
  it("returns general mode for normal coding requests", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-loop-"));
    const result = await runAgentLoop({ prompt: "fix this React timeline resize bug", requestedMode: "general", cwd }, { maxIterations: 1 });
    expect(result.mode).toBe("general");
  });
  it("emits tool result details as render metadata", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-loop-"));
    const audit: ToolDefinition = {
      name: "extension_demo_audit",
      description: "Audit repo",
      parse: (args) => args,
      async execute() {
        return {
          content: [{ type: "text", text: "audit done" }],
          details: { extensionId: "demo", toolId: "audit", renderer: "audit.summary" }
        };
      }
    };
    let turn = 0;
    const modelClient: ModelClient = {
      async complete() {
        turn += 1;
        if (turn === 1) {
          return { role: "assistant", content: [{ type: "toolCall", id: "tool-1", name: "extension_demo_audit", arguments: { scope: "src" } }], stopReason: "tool_calls", timestamp: Date.now() };
        }
        return assistantText("done");
      }
    };
    const events: AgentEvent[] = [];

    const result = await runAgentLoop({ prompt: "audit", requestedMode: "general", cwd }, {
      maxIterations: 2,
      modelClient,
      tools: [audit],
      emit: (event) => { events.push(event); }
    });

    expect(events.find((event) => event.type === "tool_execution_start")).toMatchObject({
      metadata: { source: "extension" }
    });
    expect(events.find((event) => event.type === "tool_execution_end")).toMatchObject({
      metadata: { source: "extension", extensionId: "demo", toolId: "audit", renderer: "audit.summary" },
      result: { details: { extensionId: "demo", toolId: "audit", renderer: "audit.summary" } }
    });
    expect(result.messages.find((message) => message.role === "toolResult")).toMatchObject({
      details: { extensionId: "demo", toolId: "audit", renderer: "audit.summary" }
    });
  });

  it("runs adjacent parallel-safe tool calls concurrently while preserving result order and sequential barriers", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-loop-"));
    const execution: string[] = [];
    let activeParallelCalls = 0;
    let maxActiveParallelCalls = 0;
    let releaseParallel: (() => void) | undefined;
    const parallelGate = new Promise<void>((resolve) => { releaseParallel = resolve; });
    const parallelTool: ToolDefinition = {
      name: "parallelRead",
      description: "parallel-safe read",
      executionMode: "parallel",
      parse: (args) => args,
      async execute(args) {
        const id = String(args.id);
        execution.push(`start:${id}`);
        activeParallelCalls += 1;
        maxActiveParallelCalls = Math.max(maxActiveParallelCalls, activeParallelCalls);
        if (activeParallelCalls === 2) releaseParallel?.();
        await parallelGate;
        activeParallelCalls -= 1;
        execution.push(`end:${id}`);
        return { content: [{ type: "text", text: id }] };
      }
    };
    const sequentialTool: ToolDefinition = {
      name: "sequentialWrite",
      description: "serialized write",
      executionMode: "sequential",
      parse: (args) => args,
      async execute() {
        execution.push("sequential");
        return { content: [{ type: "text", text: "sequential" }] };
      }
    };
    let turn = 0;
    const modelClient: ModelClient = {
      async complete() {
        turn += 1;
        if (turn > 1) return assistantText("done");
        return {
          role: "assistant",
          content: [
            { type: "toolCall", id: "parallel-1", name: "parallelRead", arguments: { id: "one" } },
            { type: "toolCall", id: "parallel-2", name: "parallelRead", arguments: { id: "two" } },
            { type: "toolCall", id: "sequential", name: "sequentialWrite", arguments: {} },
            { type: "toolCall", id: "parallel-3", name: "parallelRead", arguments: { id: "three" } }
          ],
          stopReason: "tool_calls",
          timestamp: Date.now()
        };
      }
    };

    const result = await runAgentLoop({ prompt: "run tools", requestedMode: "general", cwd }, {
      maxIterations: 2,
      approvalMode: "full-access",
      modelClient,
      tools: [parallelTool, sequentialTool]
    });

    expect(maxActiveParallelCalls).toBe(2);
    expect(execution.indexOf("sequential")).toBeGreaterThan(execution.indexOf("end:one"));
    expect(execution.indexOf("sequential")).toBeGreaterThan(execution.indexOf("end:two"));
    expect(execution.indexOf("start:three")).toBeGreaterThan(execution.indexOf("sequential"));
    expect(result.messages.filter((message) => message.role === "toolResult").map((message) => message.toolCallId)).toEqual([
      "parallel-1",
      "parallel-2",
      "sequential",
      "parallel-3"
    ]);
  });

  it("emits and accumulates model usage", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-loop-"));
    const events: string[] = [];
    const modelClient: ModelClient = {
      async complete(_input, _signal, stream) {
        await stream?.onUsage?.({ providerId: "test", model: "model", inputTokens: 10, outputTokens: 4, totalTokens: 14 });
        return assistantText("done");
      }
    };
    const result = await runAgentLoop({ prompt: "hello", requestedMode: "general", cwd }, {
      maxIterations: 1,
      providerId: "test",
      model: "model",
      modelClient,
      emit: (event) => { events.push(event.type); }
    });
    expect(events).toContain("usage_update");
    expect(result.usage).toMatchObject({ inputTokens: 10, outputTokens: 4, totalTokens: 14, turns: 1 });
  });
  it("records every billed turn in the cost ledger and rolls the dollar total into the usage summary", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-loop-"));
    const current = readConfig();
    writeConfig({ ...current, modelPricing: { ...current.modelPricing, "test:ledger-model": { inputPerMillionUsd: 2, outputPerMillionUsd: 10 } } });
    // The ledger is append-only and the test home is shared, so this run needs
    // its own session id to assert against.
    const sessionId = `cost-ledger-${Math.random().toString(36).slice(2)}`;
    try {
      const modelClient: ModelClient = {
        async complete(_input, _signal, stream) {
          await stream?.onUsage?.({ providerId: "test", model: "ledger-model", inputTokens: 1_000_000, outputTokens: 100_000, totalTokens: 1_100_000 });
          return assistantText("done");
        }
      };
      const result = await runAgentLoop({ prompt: "hello", requestedMode: "general", cwd }, {
        maxIterations: 1,
        providerId: "test",
        model: "ledger-model",
        sessionId,
        modelClient
      });

      expect(result.usage.costUsd).toBeCloseTo(3, 10);
      const recorded = await readCostLedger({ sessionId });
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({ providerId: "test", model: "ledger-model", totalTokens: 1_100_000, pricingSource: "config" });
      expect(recorded[0]?.costUsd).toBeCloseTo(3, 10);
    } finally {
      writeConfig(current);
    }
  });
  it("stops a run that loops on the same failing tool call", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-loop-"));
    const failing: ToolDefinition = {
      name: "grep",
      description: "Search files.",
      parse: (args) => args,
      async execute() { throw new Error("ENOTDIR: not a directory"); }
    };
    let turns = 0;
    // A model wedged on one bad call, exactly like the ENOTDIR grep loop.
    const modelClient: ModelClient = {
      async complete() {
        turns += 1;
        return { role: "assistant", content: [{ type: "toolCall", id: `tool-${turns}`, name: "grep", arguments: { pattern: "x" } }], stopReason: "tool_calls", timestamp: Date.now() };
      }
    };
    const events: AgentEvent[] = [];

    const result = await runAgentLoop({ prompt: "search", requestedMode: "general", cwd }, {
      modelClient,
      tools: [failing],
      emit: (event) => { events.push(event); }
    });

    expect(result.stallError).toContain("3 times in a row");
    expect(events.some((event) => event.type === "agent_stalled")).toBe(true);
    expect(result.summary).toContain("CrewCoder failed in general mode.");
    // Unlimited iterations must not mean unlimited spinning.
    expect(turns).toBe(3);
  });
  it("runs past the old six-iteration cap when no cap is set", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-loop-"));
    const counter: ToolDefinition = {
      name: "read",
      description: "Read a file.",
      parse: (args) => args,
      async execute() { return { content: [{ type: "text", text: "ok" }] }; }
    };
    let turns = 0;
    // Distinct args every turn: healthy progress, must never trip the detector.
    const modelClient: ModelClient = {
      async complete() {
        turns += 1;
        if (turns > 12) return assistantText("done");
        return { role: "assistant", content: [{ type: "toolCall", id: `tool-${turns}`, name: "read", arguments: { path: `file-${turns}.ts` } }], stopReason: "tool_calls", timestamp: Date.now() };
      }
    };

    const result = await runAgentLoop({ prompt: "explore", requestedMode: "general", cwd }, { modelClient, tools: [counter] });

    expect(turns).toBe(13);
    expect(result.stallError).toBeUndefined();
    expect(result.iterationCapReached).toBeUndefined();
    expect(result.summary).toContain("CrewCoder completed in general mode.");
  });
  it("reports an explicit iteration cap as a truncated run, not a success", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-loop-"));
    const counter: ToolDefinition = {
      name: "read",
      description: "Read a file.",
      parse: (args) => args,
      async execute() { return { content: [{ type: "text", text: "ok" }] }; }
    };
    let turns = 0;
    const modelClient: ModelClient = {
      async complete() {
        turns += 1;
        return { role: "assistant", content: [{ type: "toolCall", id: `tool-${turns}`, name: "read", arguments: { path: `file-${turns}.ts` } }], stopReason: "tool_calls", timestamp: Date.now() };
      }
    };

    const result = await runAgentLoop({ prompt: "explore", requestedMode: "general", cwd }, { maxIterations: 3, modelClient, tools: [counter] });

    expect(result.iterationCapReached).toBe(true);
    expect(result.summary).toContain("CrewCoder stopped early in general mode.");
    expect(turns).toBe(3);
  });
  it("surfaces provider failures as providerError instead of a successful run", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-loop-"));
    const events: string[] = [];
    let calls = 0;
    const modelClient: ModelClient = {
      async complete() {
        calls += 1;
        return { ...assistantText("opencode request failed: CreditsError: Insufficient balance.", "error"), errorMessage: "CreditsError: Insufficient balance." };
      }
    };
    const result = await runAgentLoop({ prompt: "hello", requestedMode: "general", cwd }, {
      maxIterations: 3,
      providerId: "opencode",
      model: "claude-sonnet-5",
      modelClient,
      emit: (event) => { events.push(event.type); }
    });

    expect(result.providerError).toBe("CreditsError: Insufficient balance.");
    expect(events).toContain("provider_error");
    expect(result.summary).toContain("CrewCoder failed in general mode.");
    // A failing provider must stop the loop, not burn every iteration.
    expect(calls).toBe(1);
  });
  it("leaves providerError unset on a successful run", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-loop-"));
    const modelClient: ModelClient = { async complete() { return assistantText("all good"); } };
    const result = await runAgentLoop({ prompt: "hello", requestedMode: "general", cwd }, {
      maxIterations: 1,
      providerId: "test",
      model: "model",
      modelClient
    });

    expect(result.providerError).toBeUndefined();
    expect(result.summary).toContain("CrewCoder completed in general mode.");
  });
  it("auto-compacts mid-session when live context exceeds the threshold", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-loop-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-home-"));
    const originalHome = process.env.CREWCODER_HOME;
    process.env.CREWCODER_HOME = home;
    try {
      // 12 seed messages: <= minMessages(14), so start-of-session compaction does NOT fire.
      const initialMessages: AgentMessage[] = [];
      for (let i = 0; i < 6; i++) {
        initialMessages.push(textMessage("user", `history user ${i}`));
        initialMessages.push(assistantText(`history reply ${i}`));
      }
      const noop: ToolDefinition = {
        name: "noop",
        description: "no-op tool used to keep the loop iterating",
        parse: (args) => args,
        async execute() { return { content: [{ type: "text", text: "ok" }] }; }
      };
      let turn = 0;
      const modelClient: ModelClient = {
        async complete(input, _signal, stream) {
          if (input.availableTools.length === 0) {
            // Summarization call issued by compactLiveMessages.
            return assistantText("- compacted history summary");
          }
          turn += 1;
          await stream?.onUsage?.({ providerId: "test", model: "m", inputTokens: 200_000, outputTokens: 5, totalTokens: 200_005 });
          if (turn === 1) {
            return { role: "assistant", content: [{ type: "text", text: "use a tool" }, { type: "toolCall", id: "t1", name: "noop", arguments: {} }], stopReason: "tool_calls", timestamp: Date.now() };
          }
          return assistantText("final answer");
        }
      };
      const events: string[] = [];
      const result = await runAgentLoop({ prompt: "keep going", requestedMode: "general", cwd }, {
        maxIterations: 3,
        providerId: "test",
        model: "m",
        modelClient,
        tools: [noop],
        autoCompact: true,
        autoCompactThresholdTokens: 150_000,
        initialMessages,
        emit: (event) => { events.push(event.type); }
      });
      expect(events).toContain("session_compacted");
      expect(result.compactions.length).toBeGreaterThanOrEqual(1);
      expect(result.compactions.at(-1)?.summary).toContain("compacted history summary");
    } finally {
      if (originalHome === undefined) delete process.env.CREWCODER_HOME; else process.env.CREWCODER_HOME = originalHome;
    }
  });
  it.each([
    { label: "automatic 60% boundary", autoCompact: true, lastInputTokens: 61_000 },
    { label: "disabled 80% safety boundary", autoCompact: false, lastInputTokens: 81_000 }
  ])("preflight-compacts a resumed session at the $label", async ({ autoCompact, lastInputTokens }) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-loop-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-home-"));
    const originalHome = process.env.CREWCODER_HOME;
    process.env.CREWCODER_HOME = home;
    try {
      const initialMessages: AgentMessage[] = [];
      for (let i = 0; i < 8; i++) {
        initialMessages.push(textMessage("user", `history user ${i}`));
        initialMessages.push(assistantText(`history reply ${i}`));
      }
      const normalInputs: AgentMessage[][] = [];
      const resetSessionIds: string[] = [];
      const modelClient: ModelClient = {
        resetSessionContinuation(sessionId) { resetSessionIds.push(sessionId); },
        async complete(input) {
          if (input.availableTools.length === 0) return assistantText("- preflight safety summary");
          normalInputs.push(input.messages);
          return assistantText("continued safely");
        }
      };
      const events: string[] = [];
      const result = await runAgentLoop({ prompt: "continue", requestedMode: "general", cwd }, {
        maxIterations: 1,
        providerId: "any-provider",
        model: "small-context-model",
        contextWindow: 100_000,
        modelClient,
        autoCompact,
        initialMessages,
        initialUsage: { turns: 1, lastInputTokens },
        initialProviderSessionIds: { "any-provider": "stale-native-session" },
        emit: (event) => { events.push(event.type); }
      });

      expect(events).toContain("session_compacted");
      expect(result.compactions.at(-1)?.summary).toContain("preflight safety summary");
      expect(normalInputs).toHaveLength(1);
      expect(normalInputs[0]).toHaveLength(9);
      expect(getText(normalInputs[0]![0]!)).toContain("preflight safety summary");
      expect(result.providerSessionIds).toEqual({});
      expect(resetSessionIds).toEqual([result.sessionId]);
    } finally {
      if (originalHome === undefined) delete process.env.CREWCODER_HOME; else process.env.CREWCODER_HOME = originalHome;
    }
  });
  it("honors a manual compaction signal mid-run even with auto-compaction disabled", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-loop-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-home-"));
    const originalHome = process.env.CREWCODER_HOME;
    process.env.CREWCODER_HOME = home;
    try {
      const initialMessages: AgentMessage[] = [];
      for (let i = 0; i < 6; i++) {
        initialMessages.push(textMessage("user", `history user ${i}`));
        initialMessages.push(assistantText(`history reply ${i}`));
      }
      const noop: ToolDefinition = {
        name: "noop",
        description: "no-op tool used to keep the loop iterating",
        parse: (args) => args,
        async execute() { return { content: [{ type: "text", text: "ok" }] }; }
      };
      let turn = 0;
      const resetSessionIds: string[] = [];
      const modelClient: ModelClient = {
        resetSessionContinuation(sessionId) { resetSessionIds.push(sessionId); },
        async complete(input) {
          if (input.availableTools.length === 0) return assistantText("- manual compaction summary");
          turn += 1;
          if (turn === 1) {
            return { role: "assistant", content: [{ type: "text", text: "use a tool" }, { type: "toolCall", id: "t1", name: "noop", arguments: {} }], stopReason: "tool_calls", timestamp: Date.now() };
          }
          return assistantText("final answer");
        }
      };
      const manualCompactSignal = { requested: true };
      const events: string[] = [];
      const result = await runAgentLoop({ prompt: "keep going", requestedMode: "general", cwd }, {
        maxIterations: 3,
        modelClient,
        tools: [noop],
        autoCompact: false,
        manualCompactSignal,
        initialMessages,
        initialProviderSessionIds: { claude: "stale-native-session" },
        emit: (event) => { events.push(event.type); }
      });
      expect(events).toContain("session_compacted");
      expect(result.compactions.at(-1)?.summary).toContain("manual compaction summary");
      expect(result.providerSessionIds).toEqual({});
      expect(resetSessionIds).toEqual([result.sessionId]);
      // Signal is consumed (reset) after firing once.
      expect(manualCompactSignal.requested).toBe(false);
    } finally {
      if (originalHome === undefined) delete process.env.CREWCODER_HOME; else process.env.CREWCODER_HOME = originalHome;
    }
  });
  it("previews a manual compaction and installs the user-edited summary", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-loop-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-home-"));
    const originalHome = process.env.CREWCODER_HOME;
    process.env.CREWCODER_HOME = home;
    try {
      const initialMessages: AgentMessage[] = [];
      for (let i = 0; i < 6; i++) {
        initialMessages.push(textMessage("user", `history user ${i}`));
        initialMessages.push(assistantText(`history reply ${i}`));
      }
      const noop: ToolDefinition = {
        name: "noop",
        description: "no-op tool used to keep the loop iterating",
        parse: (args) => args,
        async execute() { return { content: [{ type: "text", text: "ok" }] }; }
      };
      let turn = 0;
      const modelClient: ModelClient = {
        async complete(input) {
          if (input.availableTools.length === 0) return assistantText("- proposed summary");
          turn += 1;
          if (turn === 1) {
            return { role: "assistant", content: [{ type: "text", text: "use a tool" }, { type: "toolCall", id: "t1", name: "noop", arguments: {} }], stopReason: "tool_calls", timestamp: Date.now() };
          }
          return assistantText("final answer");
        }
      };
      const manualCompactSignal = { requested: true, preview: true };
      const compactionPreviewSignal = { decisions: [] as Array<{ previewId: string; approved: boolean; summary?: string }> };
      const events: string[] = [];
      const result = await runAgentLoop({ prompt: "keep going", requestedMode: "general", cwd }, {
        maxIterations: 3,
        modelClient,
        tools: [noop],
        autoCompact: false,
        manualCompactSignal,
        compactionPreviewSignal,
        initialMessages,
        emit: (event) => {
          events.push(event.type);
          // The host approves the preview with an edited summary.
          if (event.type === "session_compaction_preview") {
            compactionPreviewSignal.decisions.push({ previewId: event.previewId, approved: true, summary: "curated summary" });
          }
        }
      });
      expect(events).toContain("session_compaction_preview");
      expect(events).toContain("session_compacted");
      expect(result.compactions.at(-1)?.summary).toBe("curated summary");
    } finally {
      if (originalHome === undefined) delete process.env.CREWCODER_HOME; else process.env.CREWCODER_HOME = originalHome;
    }
  });
  it("leaves context unchanged when a compaction preview is cancelled", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-loop-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-home-"));
    const originalHome = process.env.CREWCODER_HOME;
    process.env.CREWCODER_HOME = home;
    try {
      const initialMessages: AgentMessage[] = [];
      for (let i = 0; i < 6; i++) {
        initialMessages.push(textMessage("user", `history user ${i}`));
        initialMessages.push(assistantText(`history reply ${i}`));
      }
      const noop: ToolDefinition = {
        name: "noop",
        description: "no-op tool used to keep the loop iterating",
        parse: (args) => args,
        async execute() { return { content: [{ type: "text", text: "ok" }] }; }
      };
      let turn = 0;
      const modelClient: ModelClient = {
        async complete(input) {
          if (input.availableTools.length === 0) return assistantText("- proposed summary");
          turn += 1;
          if (turn === 1) {
            return { role: "assistant", content: [{ type: "text", text: "use a tool" }, { type: "toolCall", id: "t1", name: "noop", arguments: {} }], stopReason: "tool_calls", timestamp: Date.now() };
          }
          return assistantText("final answer");
        }
      };
      const manualCompactSignal = { requested: true, preview: true };
      const compactionPreviewSignal = { decisions: [] as Array<{ previewId: string; approved: boolean; summary?: string }> };
      const events: string[] = [];
      const result = await runAgentLoop({ prompt: "keep going", requestedMode: "general", cwd }, {
        maxIterations: 3,
        modelClient,
        tools: [noop],
        autoCompact: false,
        manualCompactSignal,
        compactionPreviewSignal,
        initialMessages,
        emit: (event) => {
          events.push(event.type);
          if (event.type === "session_compaction_preview") {
            compactionPreviewSignal.decisions.push({ previewId: event.previewId, approved: false });
          }
        }
      });
      expect(events).toContain("session_compaction_preview");
      expect(events).not.toContain("session_compacted");
      expect(result.compactions).toHaveLength(0);
    } finally {
      if (originalHome === undefined) delete process.env.CREWCODER_HOME; else process.env.CREWCODER_HOME = originalHome;
    }
  });
  it("persists each completed turn so a run killed mid-flight keeps its transcript", async () => {
    const originalHome = process.env.CREWCODER_HOME;
    process.env.CREWCODER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-home-")) + "/.crewcoder";
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-loop-"));
    try {
      const probe: ToolDefinition = {
        name: "probe",
        description: "probe",
        parse: (args) => args,
        async execute() { return { content: [{ type: "text" as const, text: "probed" }] }; }
      };
      let sessionId = "";
      let messagesAfterFirstTurn = 0;
      let turn = 0;
      const modelClient: ModelClient = {
        async complete() {
          turn += 1;
          // Read the on-disk session between turns: turn 1's work must already be
          // durable before turn 2 starts, not buffered until the run ends.
          if (turn === 2 && sessionId) {
            messagesAfterFirstTurn = (await loadSession(sessionId)).messages.length;
          }
          if (turn >= 3) return assistantText("done");
          return {
            role: "assistant" as const,
            content: [{ type: "toolCall" as const, id: `call_${turn}`, name: "probe", arguments: {} }],
            stopReason: "tool_calls" as const,
            timestamp: Date.now()
          };
        }
      };

      const result = await runAgentLoop({ prompt: "probe twice", requestedMode: "general", cwd }, {
        maxIterations: 5,
        modelClient,
        tools: [probe],
        emit: (event) => { if (event.type === "agent_start") sessionId = event.sessionId; }
      });

      expect(messagesAfterFirstTurn).toBeGreaterThan(0);
      const persisted = await loadSession(result.sessionId);
      expect(persisted.messages.length).toBe(result.messages.length);
    } finally {
      if (originalHome === undefined) delete process.env.CREWCODER_HOME; else process.env.CREWCODER_HOME = originalHome;
    }
  });

  it("keeps completed turns when the provider fails mid-run", async () => {
    const originalHome = process.env.CREWCODER_HOME;
    process.env.CREWCODER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-home-")) + "/.crewcoder";
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-loop-"));
    try {
      const probe: ToolDefinition = {
        name: "probe",
        description: "probe",
        parse: (args) => args,
        async execute() { return { content: [{ type: "text" as const, text: "probed" }] }; }
      };
      let sessionId = "";
      let turn = 0;
      const modelClient: ModelClient = {
        async complete() {
          turn += 1;
          if (turn === 1) {
            return {
              role: "assistant" as const,
              content: [{ type: "toolCall" as const, id: "call_1", name: "probe", arguments: {} }],
              stopReason: "tool_calls" as const,
              timestamp: Date.now()
            };
          }
          throw new Error("provider exploded");
        }
      };

      await expect(runAgentLoop({ prompt: "probe then crash", requestedMode: "general", cwd }, {
        maxIterations: 5,
        modelClient,
        tools: [probe],
        emit: (event) => { if (event.type === "agent_start") sessionId = event.sessionId; }
      })).rejects.toThrow("provider exploded");

      const persisted = await loadSession(sessionId);
      expect(persisted.messages.some((message) => message.role === "toolResult")).toBe(true);
    } finally {
      if (originalHome === undefined) delete process.env.CREWCODER_HOME; else process.env.CREWCODER_HOME = originalHome;
    }
  });

  it("injects queued follow-ups into the active run and continues", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-loop-"));
    const seenInputs: string[][] = [];
    const followUpSignal = { messages: [] as string[] };
    let turn = 0;
    const modelClient: ModelClient = {
      async complete(input) {
        turn += 1;
        seenInputs.push(input.messages.map((message) => getText(message as AgentMessage)));
        if (turn === 1) {
          followUpSignal.messages.push("also include edge-case tests");
          return assistantText("initial answer");
        }
        return assistantText("answered follow-up");
      }
    };

    const events: Array<{ type: string; text?: string }> = [];
    const result = await runAgentLoop({ prompt: "implement feature", requestedMode: "general", cwd }, {
      maxIterations: 3,
      modelClient,
      followUpSignal,
      emit: (event) => {
        if (event.type === "message_end" && event.message.role === "user") events.push({ type: event.type, text: getText(event.message) });
      }
    });

    expect(turn).toBe(2);
    expect(seenInputs[0]?.some((text) => text.includes("also include edge-case tests"))).toBe(false);
    expect(seenInputs[1]?.some((text) => text.includes("also include edge-case tests"))).toBe(true);
    expect(events.some((event) => event.text === "also include edge-case tests")).toBe(true);
    expect(result.messages.some((message) => message.role === "user" && getText(message).includes("also include edge-case tests"))).toBe(true);
    expect(getText(result.messages.at(-1)!)).toContain("answered follow-up");
  });

  it("waits for interactive approval decisions before running review tools", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-loop-"));
    const approvalSignal = { decisions: [] as Array<{ approvalId: string; approved: boolean; reason?: string }> };
    let executed = 0;
    const mutate: ToolDefinition = {
      name: "mutate",
      description: "mutates project files",
      isMutation: true,
      parse: (args) => args,
      async execute() {
        executed += 1;
        return { content: [{ type: "text", text: "mutated" }] };
      }
    };
    const modelClient: ModelClient = {
      async complete(input) {
        const sawToolResult = input.messages.some((message) => message.role === "toolResult" && getText(message as AgentMessage).includes("mutated"));
        if (sawToolResult) return assistantText("done after approval");
        return {
          role: "assistant",
          content: [{ type: "toolCall", id: "call_mutate", name: "mutate", arguments: {} }],
          stopReason: "tool_calls",
          timestamp: Date.now()
        };
      }
    };
    const events: string[] = [];

    const result = await runAgentLoop({ prompt: "mutate after approval", requestedMode: "general", cwd }, {
      maxIterations: 2,
      approvalMode: "review",
      approvalSignal,
      tools: [mutate],
      modelClient,
      emit: (event) => {
        events.push(event.type);
        if (event.type === "approval_required") {
          approvalSignal.decisions.push({ approvalId: event.approvalId, approved: true, reason: "test approved" });
        }
      }
    });

    expect(executed).toBe(1);
    expect(events).toEqual(expect.arrayContaining(["approval_required", "approval_resolved", "tool_execution_start"]));
    expect(getText(result.messages.at(-1)!)).toContain("done after approval");
  });

  it("stops review tools when interactive approval is denied", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-loop-"));
    const approvalSignal = { decisions: [] as Array<{ approvalId: string; approved: boolean; reason?: string }> };
    let executed = false;
    const mutate: ToolDefinition = {
      name: "mutate",
      description: "mutates project files",
      isMutation: true,
      parse: (args) => args,
      async execute() {
        executed = true;
        return { content: [{ type: "text", text: "mutated" }] };
      }
    };
    const modelClient: ModelClient = {
      async complete() {
        return {
          role: "assistant",
          content: [{ type: "toolCall", id: "call_mutate", name: "mutate", arguments: {} }],
          stopReason: "tool_calls",
          timestamp: Date.now()
        };
      }
    };

    const result = await runAgentLoop({ prompt: "mutate after approval", requestedMode: "general", cwd }, {
      maxIterations: 2,
      approvalMode: "review",
      approvalSignal,
      tools: [mutate],
      modelClient,
      emit: (event) => {
        if (event.type === "approval_required") {
          approvalSignal.decisions.push({ approvalId: event.approvalId, approved: false, reason: "test denied" });
        }
      }
    });

    expect(executed).toBe(false);
    const denied = result.messages.find((message) => message.role === "toolResult");
    expect(denied ? getText(denied) : "").toContain("Approval denied");
    expect(result.approvalDenied).toMatchObject({
      approvalId: "approval_call_mutate",
      toolCallId: "call_mutate",
      toolName: "mutate",
      reason: "test denied"
    });
    expect(result.summary).toContain("CrewCoder failed");
  });

  it("runs trusted extension file triggers after file changes", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-loop-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-home-file-trigger-"));
    const previousHome = process.env.CREWCODER_HOME;
    process.env.CREWCODER_HOME = home;
    try {
      const marker = path.join(home, "trigger-output.txt");
      const extensionDir = path.join(home, "extensions", "trigger-pack");
      fs.mkdirSync(extensionDir, { recursive: true });
      fs.writeFileSync(path.join(extensionDir, "crewcoder.extension.json"), JSON.stringify({
        id: "trigger-pack",
        name: "Trigger Pack",
        version: "0.1.0",
        crewcoder: { apiVersion: "0.1" },
        contributes: { fileTriggers: [{ id: "docs", title: "Docs", patterns: ["docs/*.md"], command: process.execPath, args: ["-e", `const fs=require('fs'); fs.writeFileSync(${JSON.stringify(marker)}, process.argv[1], 'utf8')`, "{{path}}"] }] }
      }), "utf8");
      writeConfig({ ...readConfig(), allowExtensionHooks: true, trustedExtensions: ["trigger-pack"] });

      const writeDocs: ToolDefinition = {
        name: "writeDocs",
        description: "write docs",
        isMutation: true,
        parse: (args) => args,
        async execute(_args, context) {
          context.mutationLog.push("docs/guide.md");
          return { content: [{ type: "text", text: "wrote docs" }] };
        }
      };
      const modelClient: ModelClient = {
        async complete() {
          return { role: "assistant", content: [{ type: "toolCall", id: "call_docs", name: "writeDocs", arguments: {} }], stopReason: "tool_calls", timestamp: Date.now() };
        }
      };

      await runAgentLoop({ prompt: "write docs", requestedMode: "general", cwd }, { maxIterations: 1, approvalMode: "full-access", tools: [writeDocs], modelClient });

      expect(fs.readFileSync(marker, "utf8")).toBe("docs/guide.md");
    } finally {
      if (previousHome === undefined) delete process.env.CREWCODER_HOME;
      else process.env.CREWCODER_HOME = previousHome;
    }
  });

  it("dispatches agent events to trusted module extension handlers", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-loop-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-home-agent-event-"));
    const previousHome = process.env.CREWCODER_HOME;
    process.env.CREWCODER_HOME = home;
    clearCrewCoderExtensionRuntimeCache();
    try {
      const marker = path.join(home, "agent-events.log");
      const extensionDir = path.join(home, "extensions", "event-pack");
      fs.mkdirSync(extensionDir, { recursive: true });
      fs.writeFileSync(path.join(extensionDir, "index.mjs"), `import fs from 'node:fs'; export default function (crew) { crew.handleEvent('agent_event', (event) => { fs.appendFileSync(${JSON.stringify(marker)}, event.type + '\\n'); }); }`, "utf8");
      fs.writeFileSync(path.join(extensionDir, "crewcoder.extension.json"), JSON.stringify({
        id: "event-pack",
        name: "Event Pack",
        version: "0.1.0",
        crewcoder: { apiVersion: "0.1" },
        main: "index.mjs"
      }), "utf8");
      writeConfig({ ...readConfig(), allowExtensionModules: true, trustedExtensions: ["event-pack"] });
      clearCrewCoderExtensionRuntimeCache();

      const modelClient: ModelClient = { async complete() { return assistantText("observed"); } };
      await runAgentLoop({ prompt: "observe run", requestedMode: "general", cwd }, { maxIterations: 1, modelClient });

      const observed = fs.readFileSync(marker, "utf8").trim().split("\n");
      expect(observed).toEqual(expect.arrayContaining(["agent_start", "message_start", "message_end", "turn_start", "turn_end", "agent_end"]));
    } finally {
      clearCrewCoderExtensionRuntimeCache();
      if (previousHome === undefined) delete process.env.CREWCODER_HOME;
      else process.env.CREWCODER_HOME = previousHome;
    }
  });

  it("blocks tool execution when a trusted extension approval policy matches", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-loop-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-home-policy-"));
    const previousHome = process.env.CREWCODER_HOME;
    process.env.CREWCODER_HOME = home;
    try {
      const extensionDir = path.join(home, "extensions", "safety-pack");
      fs.mkdirSync(extensionDir, { recursive: true });
      fs.writeFileSync(path.join(extensionDir, "crewcoder.extension.json"), JSON.stringify({
        id: "safety-pack",
        name: "Safety Pack",
        version: "0.1.0",
        crewcoder: { apiVersion: "0.1" },
        contributes: { approvalPolicies: [{ id: "env", title: "Protect env", action: "block", paths: [".env*"], reason: "Secrets are protected" }] }
      }), "utf8");
      writeConfig({ ...readConfig(), allowExtensionHooks: true, trustedExtensions: ["safety-pack"] });

      let executed = false;
      const writeTool: ToolDefinition = {
        name: "write",
        description: "write file",
        isMutation: true,
        parse: (args) => args,
        async execute() {
          executed = true;
          return { content: [{ type: "text", text: "wrote" }] };
        }
      };
      const modelClient: ModelClient = {
        async complete() {
          return {
            role: "assistant",
            content: [{ type: "toolCall", id: "call_write", name: "write", arguments: { path: ".env.local", content: "SECRET=1" } }],
            stopReason: "tool_calls",
            timestamp: Date.now()
          };
        }
      };

      const result = await runAgentLoop({ prompt: "write env", requestedMode: "general", cwd }, {
        maxIterations: 1,
        approvalMode: "full-access",
        tools: [writeTool],
        modelClient
      });

      expect(executed).toBe(false);
      const blocked = result.messages.find((message) => message.role === "toolResult");
      expect(blocked ? getText(blocked) : "").toContain("Blocked by extension approval policy");
      expect(blocked ? getText(blocked) : "").toContain("Secrets are protected");
    } finally {
      if (previousHome === undefined) delete process.env.CREWCODER_HOME;
      else process.env.CREWCODER_HOME = previousHome;
    }
  });

  it("runs dangerous bash commands in full-access mode without approval prompts", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-loop-"));
    let executedCommand = "";
    const bash: ToolDefinition = {
      name: "bash",
      description: "runs shell commands",
      parse: (args) => args,
      async execute(args) {
        executedCommand = String(args.command ?? "");
        return { content: [{ type: "text", text: "dangerous command ran with full access" }] };
      }
    };
    const modelClient: ModelClient = {
      async complete(input) {
        const sawToolResult = input.messages.some((message) => message.role === "toolResult" && getText(message as AgentMessage).includes("full access"));
        if (sawToolResult) return assistantText("done after full access");
        return {
          role: "assistant",
          content: [{ type: "toolCall", id: "call_bash", name: "bash", arguments: { command: "rm -rf ./tmp-danger-test" } }],
          stopReason: "tool_calls",
          timestamp: Date.now()
        };
      }
    };
    const events: string[] = [];

    const result = await runAgentLoop({ prompt: "run a dangerous command with full access", requestedMode: "general", cwd }, {
      maxIterations: 2,
      approvalMode: "full-access",
      tools: [bash],
      modelClient,
      emit: (event) => {
        events.push(event.type);
      }
    });

    expect(executedCommand).toBe("rm -rf ./tmp-danger-test");
    expect(events).not.toContain("approval_required");
    expect(events).toContain("tool_execution_start");
    expect(getText(result.messages.at(-1)!)).toContain("done after full access");
  });

  it("runs dangerous bash commands after explicit interactive approval", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-loop-"));
    const approvalSignal = { decisions: [] as Array<{ approvalId: string; approved: boolean; reason?: string }> };
    let executedCommand = "";
    const bash: ToolDefinition = {
      name: "bash",
      description: "runs shell commands",
      parse: (args) => args,
      async execute(args) {
        executedCommand = String(args.command ?? "");
        return { content: [{ type: "text", text: "dangerous command was approved" }] };
      }
    };
    const modelClient: ModelClient = {
      async complete(input) {
        const sawToolResult = input.messages.some((message) => message.role === "toolResult" && getText(message as AgentMessage).includes("approved"));
        if (sawToolResult) return assistantText("done after dangerous approval");
        return {
          role: "assistant",
          content: [{ type: "toolCall", id: "call_bash", name: "bash", arguments: { command: "rm -rf ./tmp-danger-test" } }],
          stopReason: "tool_calls",
          timestamp: Date.now()
        };
      }
    };
    const events: string[] = [];

    const result = await runAgentLoop({ prompt: "run a dangerous command after approval", requestedMode: "general", cwd }, {
      maxIterations: 2,
      approvalMode: "review",
      approvalSignal,
      tools: [bash],
      modelClient,
      emit: (event) => {
        events.push(event.type);
        if (event.type === "approval_required") {
          approvalSignal.decisions.push({ approvalId: event.approvalId, approved: true, reason: "explicit dangerous approval" });
        }
      }
    });

    expect(executedCommand).toBe("rm -rf ./tmp-danger-test");
    expect(events).toEqual(expect.arrayContaining(["approval_required", "approval_resolved", "tool_execution_start"]));
    expect(getText(result.messages.at(-1)!)).toContain("done after dangerous approval");
  });

  it("writes audit entries for approved mutating tool calls", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-loop-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-home-"));
    const originalHome = process.env.CREWCODER_HOME;
    process.env.CREWCODER_HOME = home;
    try {
      const approvalSignal = { decisions: [] as Array<{ approvalId: string; approved: boolean; reason?: string }> };
      const writeFile: ToolDefinition = {
        name: "write",
        description: "write file",
        isMutation: true,
        parse: (args) => args,
        async execute(args, context) {
          const file = path.join(context.cwd, String(args.path));
          fs.writeFileSync(file, String(args.content), "utf8");
          context.mutationLog.push(String(args.path));
          return { content: [{ type: "text", text: "wrote" }], details: { path: String(args.path) } };
        }
      };
      let turn = 0;
      const modelClient: ModelClient = {
        async complete() {
          turn += 1;
          if (turn === 1) return { role: "assistant", content: [{ type: "toolCall", id: "call_write", name: "write", arguments: { path: "out.txt", content: "API_TOKEN=secret-value" } }], stopReason: "tool_calls", timestamp: Date.now() };
          return assistantText("done");
        }
      };

      await runAgentLoop({ prompt: "write audit", requestedMode: "general", cwd }, {
        sessionId: "session_audit_test",
        maxIterations: 2,
        approvalMode: "always",
        approvalSignal,
        tools: [writeFile],
        modelClient,
        emit: (event) => {
          if (event.type === "approval_required") approvalSignal.decisions.push({ approvalId: event.approvalId, approved: true, reason: "approved in test" });
        }
      });

      const entries = await readAuditLog();
      expect(entries.map((entry) => entry.type)).toEqual(expect.arrayContaining(["tool_call", "approval", "tool_result", "write"]));
      expect(entries.find((entry) => entry.type === "tool_call")).toMatchObject({ sessionId: "session_audit_test", toolCallId: "call_write", toolName: "write", args: { path: "out.txt", content: "API_TOKEN=[REDACTED]" } });
      expect(entries.find((entry) => entry.type === "approval" && entry.approved === true)).toMatchObject({ toolCallId: "call_write", toolName: "write", reason: "approved in test" });
      expect(entries.find((entry) => entry.type === "write")).toMatchObject({ path: "out.txt", toolName: "write" });
    } finally {
      if (originalHome === undefined) delete process.env.CREWCODER_HOME;
      else process.env.CREWCODER_HOME = originalHome;
    }
  });

  it("dumps exact model input when requested", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-loop-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-home-"));
    const originalHome = process.env.CREWCODER_HOME;
    process.env.CREWCODER_HOME = home;
    try {
      const modelClient: ModelClient = {
        async complete(input) {
          expect(input.systemPrompt).toContain("CrewCoder");
          expect(input.messages.at(-1)?.role).toBe("user");
          expect(input.availableTools.length).toBeGreaterThan(0);
          return assistantText("dumped");
        }
      };

      await runAgentLoop({ prompt: "show dump payload\nOPENAI_API_KEY=sk-test-secret", requestedMode: "general", cwd }, {
        sessionId: "session_dump_test",
        maxIterations: 1,
        providerId: "test-provider",
        model: "test-model",
        modelClient,
        dumpModelInput: true
      });

      const dumpPath = path.join(home, "logs", "model-input-session_dump_test-turn-1.json");
      const dump = JSON.parse(fs.readFileSync(dumpPath, "utf8"));
      expect(dump).toMatchObject({
        sessionId: "session_dump_test",
        iteration: 1,
        providerId: "test-provider",
        model: "test-model"
      });
      expect(dump.modelInput.systemPrompt).toContain("CrewCoder");
      const dumpedUserText = dump.modelInput.messages.at(-1).content[0].text;
      expect(dumpedUserText).toContain("show dump payload");
      expect(dumpedUserText).toContain("OPENAI_API_KEY=[REDACTED]");
      expect(dumpedUserText).not.toContain("sk-test-secret");
      expect(dumpedUserText).toContain("Background:");
      expect(dump.modelInput.session).toMatchObject({ sessionId: "session_dump_test", continuation: false });
      expect(dump.modelInput.availableTools.some((tool: any) => tool.name === "read")).toBe(true);
    } finally {
      if (originalHome === undefined) delete process.env.CREWCODER_HOME;
      else process.env.CREWCODER_HOME = originalHome;
    }
  });

  it("injects matching repository rules as user background", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-loop-rules-"));
    fs.mkdirSync(path.join(cwd, ".crewcoder", "rules"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".crewcoder", "rules", "common.md"), "Always preserve public APIs.\n");
    fs.writeFileSync(path.join(cwd, ".crewcoder", "rules", "typescript.md"), "---\npaths:\n  - '**/*.ts'\n---\nUse strict TypeScript.\n");
    fs.writeFileSync(path.join(cwd, ".crewcoder", "rules", "python.md"), "---\npaths:\n  - '**/*.py'\n---\nUse pytest.\n");
    fs.writeFileSync(path.join(cwd, "index.ts"), "export {};\n");

    const modelClient: ModelClient = {
      async complete(input) {
        const rendered = JSON.stringify(input.messages);
        expect(rendered).toContain("Repository CrewCoder rules (.crewcoder/rules)");
        expect(rendered).toContain("Always preserve public APIs.");
        expect(rendered).toContain("Use strict TypeScript.");
        expect(rendered).not.toContain("Use pytest.");
        return assistantText("done");
      }
    };

    await runAgentLoop({ prompt: "review this", requestedMode: "general", cwd }, {
      sessionId: "session_rules_context",
      maxIterations: 1,
      modelClient
    });
  });

  it("appends the selected custom system prompt after the default prompt", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-loop-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-home-"));
    const originalHome = process.env.CREWCODER_HOME;
    process.env.CREWCODER_HOME = home;
    try {
      const stored = saveSystemPrompt("strict-review", "Custom review rules must run after defaults.");

      const modelClient: ModelClient = {
        async complete(input) {
          const defaultIndex = input.systemPrompt.indexOf("You are in General Coding Agent mode.");
          const customIndex = input.systemPrompt.indexOf("Custom review rules must run after defaults.");
          expect(defaultIndex).toBeGreaterThanOrEqual(0);
          expect(customIndex).toBeGreaterThan(defaultIndex);
          expect(input.systemPrompt).toContain("Custom system prompt:");
          return assistantText("done");
        }
      };

      const result = await runAgentLoop({ prompt: "review this", requestedMode: "general", cwd }, {
        sessionId: "session_custom_prompt",
        maxIterations: 1,
        systemPromptName: stored.name,
        modelClient
      });
      const session = await loadSession(result.sessionId);
      expect(session.systemPrompt).toMatchObject({ name: "strict-review", path: stored.path });
    } finally {
      if (originalHome === undefined) delete process.env.CREWCODER_HOME;
      else process.env.CREWCODER_HOME = originalHome;
    }
  });

  it("does not inject stored system prompts unless one is selected for the run", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-loop-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-home-"));
    const originalHome = process.env.CREWCODER_HOME;
    process.env.CREWCODER_HOME = home;
    try {
      saveSystemPrompt("strict-review", "This should not be injected by default.");
      const modelClient: ModelClient = {
        async complete(input) {
          expect(input.systemPrompt).toContain("You are in General Coding Agent mode.");
          expect(input.systemPrompt).not.toContain("This should not be injected by default.");
          return assistantText("done");
        }
      };

      const result = await runAgentLoop({ prompt: "new session", requestedMode: "general", cwd }, {
        sessionId: "session_default_prompt",
        maxIterations: 1,
        modelClient
      });
      const session = await loadSession(result.sessionId);
      expect(session.systemPrompt).toBeUndefined();
    } finally {
      if (originalHome === undefined) delete process.env.CREWCODER_HOME;
      else process.env.CREWCODER_HOME = originalHome;
    }
  });

  it("emits provider_error when model client returns an error stopReason", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-loop-"));
    const mockClient: ModelClient = {
      async complete() {
        return assistantText("Provider failed", "error");
      }
    };
    const result = await runAgentLoop({ prompt: "any prompt", requestedMode: "general", cwd }, { maxIterations: 1, modelClient: mockClient, providerId: "test-provider" });
    const session = await loadSession(result.sessionId);
    const providerErrors = session.events.filter((event): event is Extract<AgentEvent, { type: "provider_error" }> => event.type === "provider_error");
    expect(providerErrors.length).toBe(1);
    expect(providerErrors[0]?.message).toBe("Provider failed");
  });
  it("emits file_changed for edit and edit_transaction paths", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-loop-"));
    fs.writeFileSync(path.join(cwd, "one.txt"), "before one\n", "utf8");
    fs.writeFileSync(path.join(cwd, "two.txt"), "before two\n", "utf8");
    let turn = 0;
    const modelClient: ModelClient = {
      async complete() {
        turn += 1;
        if (turn > 1) return assistantText("done");
        return {
          role: "assistant",
          content: [
            { type: "toolCall", id: "edit-one", name: "edit", arguments: { path: "one.txt", find: "before", replace: "after" } },
            { type: "toolCall", id: "edit-two", name: "edit_transaction", arguments: { edits: [{ path: "two.txt", find: "before", replace: "after" }] } }
          ],
          stopReason: "tool_calls",
          timestamp: Date.now()
        };
      }
    };
    const events: AgentEvent[] = [];

    await runAgentLoop({ prompt: "edit both files", requestedMode: "general", cwd }, {
      maxIterations: 2,
      approvalMode: "full-access",
      modelClient,
      emit: (event) => { events.push(event); }
    });

    expect(events.filter((event) => event.type === "file_changed")).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "file_changed", path: "one.txt", toolName: "edit" }),
      expect.objectContaining({ type: "file_changed", path: "two.txt", toolName: "edit_transaction" })
    ]));
  });

  it("emits file_changed with the actual tool name", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-loop-"));
    const result = await runAgentLoop({ prompt: "create a CrewCode plugin named file-change-test", requestedMode: "plugin", cwd }, { maxIterations: 2, integrationProfile: "crewcode" });
    const session = await loadSession(result.sessionId);
    const fileChanges = session.events.filter((e: any) => e.type === "file_changed");
    expect(fileChanges.length).toBeGreaterThan(0);
    expect(fileChanges.every((e: any) => e.toolName === "createPlugin")).toBe(true);
  });
  it("continues after read tool calls and returns a final answer", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-loop-"));
    fs.writeFileSync(path.join(cwd, "README.md"), "# CrewCoder\n\nLong-running agent notes.", "utf8");
    let calls = 0;
    let sawToolResult = false;
    const modelClient: ModelClient = {
      async complete(input) {
        calls += 1;
        sawToolResult ||= input.messages.some((message) => message.role === "toolResult" && getText(message).includes("Long-running agent notes."));
        if (calls === 1) {
          return {
            role: "assistant",
            content: [{ type: "toolCall", id: "call_read", name: "read", arguments: { path: "README.md" } }],
            stopReason: "tool_calls",
            timestamp: Date.now()
          };
        }
        return assistantText("README summary: CrewCoder has long-running agent notes.");
      }
    };

    const result = await runAgentLoop({ prompt: "summarize README", requestedMode: "general", cwd }, { maxIterations: 3, modelClient });

    expect(calls).toBe(2);
    expect(sawToolResult).toBe(true);
    expect(result.summary).toContain("README summary");
    const saved = await loadSession(result.sessionId);
    expect(saved.events.some((event: any) => event.type === "tool_execution_start" && event.toolName === "read")).toBe(true);
  });
  it("continues with prior session messages and cached session context", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-loop-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-home-"));
    const originalHome = process.env.CREWCODER_HOME;
    process.env.CREWCODER_HOME = home;
    try {
      await saveSession({
        id: "session_prev",
        startedAt: new Date().toISOString(),
        cwd,
        requestedMode: "general",
        resolvedMode: "general",
        prompt: "original prompt",
        events: [],
        messages: [
          { role: "user", content: [{ type: "text", text: "original prompt" }], timestamp: 1 },
          assistantText("original answer")
        ],
        mutationLog: ["README.md"],
        usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7, turns: 1 },
        providerSessionIds: { claude: "claude-native-old" }
      });

      let seenRoles: string[] | undefined;
      let seenSession: Parameters<ModelClient["complete"]>[0]["session"];
      let emittedResumedUser: AgentMessage | undefined;
      const modelClient: ModelClient = {
        async complete(input, _signal, stream) {
          seenRoles = input.messages.map((message) => message.role);
          seenSession = input.session;
          await stream?.onProviderSessionId?.("claude-native-new");
          return assistantText("continued");
        }
      };

      const result = await runAgentLoopContinue({ sessionId: "session_prev", prompt: "next prompt", cwd }, {
        maxIterations: 1,
        providerId: "claude",
        modelClient,
        emit: (event) => {
          if (event.type === "message_end" && event.message.role === "user" && getText(event.message) === "next prompt") emittedResumedUser = event.message;
        }
      });
      expect(seenRoles).toEqual(["user", "assistant", "user"]);
      expect(seenSession).toMatchObject({ resumeFromSessionId: "session_prev", continuation: true, providerSessionId: "claude-native-old" });
      expect(emittedResumedUser).toMatchObject({ role: "user" });
      expect(emittedResumedUser && "background" in emittedResumedUser).toBe(false);
      expect(result.messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
      expect(result.mutationLog).toContain("README.md");
      expect(result.sessionId).toBe("session_prev");
      const saved = await loadSession(result.sessionId);
      expect(saved.parentSessionId).toBeUndefined();
      expect(saved.messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
      expect(saved.providerSessionIds).toEqual({ claude: "claude-native-new" });
    } finally {
      if (originalHome === undefined) delete process.env.CREWCODER_HOME;
      else process.env.CREWCODER_HOME = originalHome;
    }
  });
  it("does not compact modest resumed sessions just because they crossed a small message count", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-loop-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-home-"));
    const originalHome = process.env.CREWCODER_HOME;
    process.env.CREWCODER_HOME = home;
    try {
      const messages = Array.from({ length: 18 }, (_, index) => index % 2 === 0
        ? { role: "user" as const, content: [{ type: "text" as const, text: `old user ${index}` }], timestamp: index }
        : assistantText(`old assistant ${index}`));
      await saveSession({
        id: "session_modest",
        startedAt: new Date().toISOString(),
        cwd,
        requestedMode: "general",
        resolvedMode: "general",
        prompt: "old prompt",
        events: [],
        messages,
        mutationLog: []
      });

      const modelClient: ModelClient = { async complete() { return assistantText("continued"); } };
      const result = await runAgentLoopContinue({ sessionId: "session_modest", prompt: "ok thanks", cwd }, { maxIterations: 1, modelClient });

      expect(result.compactions).toEqual([]);
      expect(result.messages.map((message) => message.role)).toHaveLength(20);
    } finally {
      if (originalHome === undefined) delete process.env.CREWCODER_HOME;
      else process.env.CREWCODER_HOME = originalHome;
    }
  });
  it("does not compact long resumed sessions automatically", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-loop-"));
    fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ name: "phase-four-test", scripts: { test: "vitest" } }), "utf8");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-home-"));
    const originalHome = process.env.CREWCODER_HOME;
    process.env.CREWCODER_HOME = home;
    try {
      const messages = Array.from({ length: 36 }, (_, index) => index % 2 === 0
        ? { role: "user" as const, content: [{ type: "text" as const, text: `old user ${index}` }], timestamp: index }
        : assistantText(`old assistant ${index}`));
      await saveSession({
        id: "session_long",
        startedAt: new Date().toISOString(),
        cwd,
        requestedMode: "general",
        resolvedMode: "general",
        prompt: "old prompt",
        events: [],
        messages,
        mutationLog: []
      });

      let seenText = "";
      let seenMessageCount = 0;
      const modelClient: ModelClient = {
        async complete(input) {
          seenMessageCount = input.messages.length;
          seenText = input.messages.map(getText).join("\n");
          return assistantText("continued");
        }
      };

      const result = await runAgentLoopContinue({ sessionId: "session_long", prompt: "next prompt", cwd }, { maxIterations: 1, modelClient });

      expect(result.compactions).toEqual([]);
      expect(seenMessageCount).toBe(37);
      expect(seenText).not.toContain("Background from compacted earlier session");
      expect(seenText).toContain("next prompt");
      const saved = await loadSession(result.sessionId);
      expect(saved.compactions).toEqual([]);
      expect(saved.events.some((event: any) => event.type === "session_compacted")).toBe(false);
    } finally {
      if (originalHome === undefined) delete process.env.CREWCODER_HOME;
      else process.env.CREWCODER_HOME = originalHome;
    }
  });
  it("emits validation_start and validation_end for validatePlugin", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-loop-"));
    const pluginDir = path.join(cwd, "val-test");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "crewcode.plugin.json"),
      JSON.stringify({ id: "val-test", name: "Val Test", crewcode: { apiVersion: "0.1" } }),
      "utf8"
    );
    const mockClient: ModelClient = {
      async complete() {
        return {
          role: "assistant",
          content: [{ type: "toolCall", id: "t1", name: "validatePlugin", arguments: { path: "." } }],
          stopReason: "tool_calls",
          timestamp: Date.now()
        };
      }
    };
    const result = await runAgentLoop({ prompt: "validate plugin", requestedMode: "plugin", cwd: pluginDir }, { maxIterations: 1, modelClient: mockClient, integrationProfile: "crewcode" });
    const session = await loadSession(result.sessionId);
    const starts = session.events.filter((event): event is Extract<AgentEvent, { type: "validation_start" }> => event.type === "validation_start");
    const ends = session.events.filter((event): event is Extract<AgentEvent, { type: "validation_end" }> => event.type === "validation_end");
    expect(starts.length).toBe(1);
    expect(ends.length).toBe(1);
    expect(ends[0]?.ok).toBe(true);
  });
  it("resumes without a prompt by replaying the saved session and does not call the model", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-loop-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-home-"));
    const originalHome = process.env.CREWCODER_HOME;
    process.env.CREWCODER_HOME = home;
    try {
      await saveSession({
        id: "session_pending",
        startedAt: new Date().toISOString(),
        cwd,
        requestedMode: "general",
        resolvedMode: "general",
        prompt: "original prompt",
        events: [],
        messages: [
          { role: "user", content: [{ type: "text", text: "original prompt" }], timestamp: 1 },
          assistantText("original answer")
        ],
        mutationLog: ["README.md"]
      });

      let modelCalled = false;
      const events: string[] = [];
      const modelClient: ModelClient = {
        async complete() {
          modelCalled = true;
          return assistantText("should not run");
        }
      };

      const result = await runAgentLoopContinue({ sessionId: "session_pending", cwd }, { maxIterations: 1, modelClient, emit: (event) => { events.push(event.type); } });

      expect(modelCalled).toBe(false);
      expect(result.sessionId).toBe("session_pending");
      expect(events).toEqual(["agent_start", "agent_end"]);
      expect(result.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
      const saved = await loadSession(result.sessionId);
      expect(saved.parentSessionId).toBeUndefined();
      expect(saved.pendingResumeContext).toBeUndefined();
    } finally {
      if (originalHome === undefined) delete process.env.CREWCODER_HOME;
      else process.env.CREWCODER_HOME = originalHome;
    }
  });
  it("does not inject pending resume context into prompted resumes", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-loop-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-home-"));
    const originalHome = process.env.CREWCODER_HOME;
    process.env.CREWCODER_HOME = home;
    try {
      await saveSession({
        id: "session_resume_first",
        startedAt: new Date().toISOString(),
        cwd,
        requestedMode: "general",
        resolvedMode: "general",
        prompt: "original prompt",
        events: [],
        messages: [
          { role: "user", content: [{ type: "text", text: "original prompt" }], timestamp: 1 },
          assistantText("original answer")
        ],
        mutationLog: [],
        pendingResumeContext: "Resume this session from the existing conversation context."
      });

      let seenPrompt = "";
      const modelClient: ModelClient = {
        async complete(input) {
          const userMessages = input.messages.filter((message) => message.role === "user");
          const lastUser = userMessages[userMessages.length - 1];
          seenPrompt = getText(lastUser);
          return assistantText("continued");
        }
      };

      const result = await runAgentLoopContinue({ sessionId: "session_resume_first", prompt: "next prompt", cwd }, { maxIterations: 1, modelClient });

      expect(seenPrompt).toBe("next prompt");
      expect(result.messages[result.messages.length - 1].role).toBe("assistant");
    } finally {
      if (originalHome === undefined) delete process.env.CREWCODER_HOME;
      else process.env.CREWCODER_HOME = originalHome;
    }
  });
  it("does not inject resume context when resuming with a prompt directly", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-loop-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-home-"));
    const originalHome = process.env.CREWCODER_HOME;
    process.env.CREWCODER_HOME = home;
    try {
      await saveSession({
        id: "session_direct_resume",
        startedAt: new Date().toISOString(),
        cwd,
        requestedMode: "general",
        resolvedMode: "general",
        prompt: "original prompt",
        events: [],
        messages: [
          { role: "user", content: [{ type: "text", text: "original prompt" }], timestamp: 1 },
          assistantText("original answer")
        ],
        mutationLog: []
      });

      let seenText = "";
      const modelClient: ModelClient = {
        async complete(input) {
          const userMessages = input.messages.filter((message) => message.role === "user");
          seenText = getText(userMessages[userMessages.length - 1]);
          return assistantText("continued");
        }
      };

      await runAgentLoopContinue({ sessionId: "session_direct_resume", prompt: "next prompt", cwd }, { maxIterations: 1, modelClient });

      expect(seenText).not.toContain("Resume this session from the existing conversation context.");
      expect(seenText).toContain("next prompt");
    } finally {
      if (originalHome === undefined) delete process.env.CREWCODER_HOME;
      else process.env.CREWCODER_HOME = originalHome;
    }
  });
});
