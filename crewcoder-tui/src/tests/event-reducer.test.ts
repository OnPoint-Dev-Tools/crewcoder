import { afterEach, describe, expect, it } from "vitest";
import { applyCrewCoderEvent } from "../state/event-reducer.js";
import { createInitialState } from "../state/tui-store.js";

describe("TUI event reducer", () => {
  afterEach(() => {
    delete process.env.CREWCODER_TUI_SYSTEM_LOGS;
  });

  it("tracks active crew workers and completion", () => {
    const state = createInitialState();

    applyCrewCoderEvent(state, { type: "crew_start", workers: ["reviewer", "builder"] });
    applyCrewCoderEvent(state, { type: "crew_worker_start", worker: "reviewer", index: 0, total: 2, sessionId: "session_reviewer" });
    expect(state.running).toBe(true);
    expect(state.crewWorkers).toEqual([
      { name: "reviewer", status: "running", sessionId: "session_reviewer" },
      { name: "builder", status: "pending" }
    ]);

    applyCrewCoderEvent(state, { type: "agent_end", sessionId: "session_reviewer", messages: [] });
    expect(state.running).toBe(false);
    applyCrewCoderEvent(state, { type: "crew_worker_end", worker: "reviewer", index: 0, total: 2, status: "completed", sessionId: "session_reviewer" });
    applyCrewCoderEvent(state, { type: "crew_worker_start", worker: "builder", index: 1, total: 2, sessionId: "session_builder" });
    expect(state.running).toBe(true);
    applyCrewCoderEvent(state, { type: "crew_worker_end", worker: "builder", index: 1, total: 2, status: "failed", sessionId: "session_builder", error: "provider failed" });
    applyCrewCoderEvent(state, { type: "crew_end", total: 2, completed: 1, failed: 1 });

    expect(state.running).toBe(false);
    expect(state.crewWorkers).toEqual([
      { name: "reviewer", status: "completed", sessionId: "session_reviewer" },
      { name: "builder", status: "failed", sessionId: "session_builder", error: "provider failed" }
    ]);
    expect(state.blocks.find((block) => block.type === "crew")).toMatchObject({ type: "crew", completed: true });
  });

  it("tracks validation lifecycle as a validation block", () => {
    const state = createInitialState();

    applyCrewCoderEvent(state, { type: "validation_start", target: "plugin" });
    applyCrewCoderEvent(state, {
      type: "validation_end",
      target: "plugin",
      ok: false,
      errors: ["missing manifest"],
      warnings: ["unused permission"]
    });

    expect(state.blocks.at(-1)).toMatchObject({
      type: "validation",
      target: "plugin",
      status: "failed",
      errors: ["missing manifest"],
      warnings: ["unused permission"]
    });
  });

  it("stores file changes once", () => {
    const state = createInitialState();

    applyCrewCoderEvent(state, { type: "file_changed", path: "src/file.ts", toolName: "edit" });
    applyCrewCoderEvent(state, { type: "file_changed", path: "src/file.ts", toolName: "write" });

    expect(state.changedFiles).toEqual(["src/file.ts"]);
  });

  it("tracks mutation paths from successful tool completion metadata", () => {
    const state = createInitialState();

    applyCrewCoderEvent(state, { type: "tool_execution_end", toolName: "edit", isError: false, metadata: { path: "src/one.ts" } });
    applyCrewCoderEvent(state, { type: "tool_execution_end", toolName: "edit_transaction", isError: false, metadata: { paths: ["src/two.ts", "src/three.ts"] } });
    applyCrewCoderEvent(state, { type: "file_changed", path: "src/one.ts", toolName: "edit" });

    expect(state.changedFiles).toEqual(["src/one.ts", "src/two.ts", "src/three.ts"]);
  });

  it("does not track paths from failed or non-mutating tool completions", () => {
    const state = createInitialState();

    applyCrewCoderEvent(state, { type: "tool_execution_end", toolName: "edit", isError: true, metadata: { path: "src/failed.ts" } });
    applyCrewCoderEvent(state, { type: "tool_execution_end", toolName: "read", isError: false, metadata: { path: "src/read.ts" } });

    expect(state.changedFiles).toEqual([]);
  });

  it("tracks background jobs without blocking the transcript", () => {
    const state = createInitialState();

    applyCrewCoderEvent(state, { type: "background_job_start", bgId: "bg_1", command: "npm run dev", cwd: "/tmp/project", startedAt: "now" });
    applyCrewCoderEvent(state, { type: "background_job_output", bgId: "bg_1", text: "ready\n" });
    applyCrewCoderEvent(state, { type: "background_job_end", bgId: "bg_1", status: "completed", exitCode: 0, endedAt: "later" });

    expect(state.blocks.at(-1)).toEqual({ type: "background_job", bgId: "bg_1", command: "npm run dev", status: "completed", output: "ready\n", exitCode: 0, startedAt: "now", endedAt: "later" });
  });

  it("streams thinking deltas into one thinking block", () => {
    const state = createInitialState();

    applyCrewCoderEvent(state, { type: "thinking_delta", text: "first " });
    applyCrewCoderEvent(state, { type: "thinking_delta", text: "second" });

    expect(state.blocks.at(-1)).toEqual({ type: "thinking", text: "first second" });
  });

  it("tracks review summaries as a dedicated block", () => {
    const state = createInitialState();

    applyCrewCoderEvent(state, {
      type: "review_summary",
      summary: {
        branch: "feature/GH-123-review-ux",
        clean: false,
        changedFiles: ["crewcoder-tui/src/components/MainViewport.ts"],
        issueReferences: [{ id: "123", source: "branch", text: "GH-123", url: "https://github.com/acme/repo/issues/123" }]
      }
    });

    expect(state.blocks.at(-1)).toEqual({
      type: "review_summary",
      summary: {
        branch: "feature/GH-123-review-ux",
        clean: false,
        changedFiles: ["crewcoder-tui/src/components/MainViewport.ts"],
        issueReferences: [{ id: "123", source: "branch", text: "GH-123", url: "https://github.com/acme/repo/issues/123" }]
      }
    });
  });

  it("tracks compaction progress as a visible meter block", () => {
    const state = createInitialState();

    applyCrewCoderEvent(state, { type: "session_compaction_progress", phase: "summarizing", percent: 35, message: "Summarizing older context…", originalMessageCount: 20, retainedMessageCount: 6 });
    applyCrewCoderEvent(state, { type: "session_compacted", compactionId: "compact_1", originalMessageCount: 20, retainedMessageCount: 6, summary: "done" });

    expect(state.blocks.at(-1)).toEqual({
      type: "compaction",
      status: "done",
      percent: 100,
      message: "session compacted: 20 -> 6 messages",
      originalMessageCount: 20,
      retainedMessageCount: 6
    });
  });

  it("renders an error-level extension notify as a visible error block", () => {
    const state = createInitialState();

    applyCrewCoderEvent(state, { type: "extension_ui_notify", extensionId: "demo", message: "build failed", level: "error" });

    expect(state.blocks.at(-1)).toEqual({ type: "error", text: "[demo] build failed" });
  });

  it("renders an info-level extension notify as a system log when enabled", () => {
    process.env.CREWCODER_TUI_SYSTEM_LOGS = "1";
    const state = createInitialState();

    applyCrewCoderEvent(state, { type: "extension_ui_notify", extensionId: "demo", message: "working", level: "info" });

    expect(state.blocks.at(-1)).toEqual({ type: "system", text: "[demo] working" });
  });

  it("tracks an extension UI request from pending to answered", () => {
    const state = createInitialState();

    applyCrewCoderEvent(state, {
      type: "extension_ui_request",
      requestId: "extui_1",
      extensionId: "demo",
      uiKind: "select",
      title: "Pick a target",
      options: [
        { label: "Staging", value: "staging" },
        { label: "Prod", value: "prod" }
      ]
    });

    expect(state.blocks.at(-1)).toMatchObject({
      type: "extension_ui",
      requestId: "extui_1",
      extensionId: "demo",
      uiKind: "select",
      title: "Pick a target",
      status: "pending",
      options: [
        { label: "Staging", value: "staging" },
        { label: "Prod", value: "prod" }
      ]
    });

    applyCrewCoderEvent(state, { type: "extension_ui_resolved", requestId: "extui_1", cancelled: false });
    expect(state.blocks.at(-1)).toMatchObject({ type: "extension_ui", requestId: "extui_1", status: "answered" });
  });

  it("tracks a declarative extension component request", () => {
    const state = createInitialState();

    applyCrewCoderEvent(state, {
      type: "extension_ui_request",
      requestId: "extui_component_1",
      extensionId: "demo",
      uiKind: "component",
      title: "Repo Status",
      component: { kind: "details", items: [{ label: "Branch", value: "main" }] },
      actions: [{ id: "apply", label: "Apply" }, { id: "close", label: "Close" }]
    });

    expect(state.blocks.at(-1)).toMatchObject({
      type: "extension_ui",
      requestId: "extui_component_1",
      extensionId: "demo",
      uiKind: "component",
      title: "Repo Status",
      status: "pending",
      component: { kind: "details", items: [{ label: "Branch", value: "main" }] },
      actions: [{ id: "apply", label: "Apply" }, { id: "close", label: "Close" }]
    });
  });

  it("marks a cancelled extension UI request as cancelled", () => {
    const state = createInitialState();

    applyCrewCoderEvent(state, { type: "extension_ui_request", requestId: "extui_2", extensionId: "demo", uiKind: "confirm", title: "Proceed?" });
    applyCrewCoderEvent(state, { type: "extension_ui_resolved", requestId: "extui_2", cancelled: true });

    expect(state.blocks.at(-1)).toMatchObject({ type: "extension_ui", requestId: "extui_2", status: "cancelled" });
  });

  it("preserves tool metadata across start, delta, and end events", () => {
    const state = createInitialState();

    applyCrewCoderEvent(state, {
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "extension_demo_audit",
      args: { scope: "src" },
      metadata: { source: "extension" }
    });
    applyCrewCoderEvent(state, {
      type: "tool_delta",
      toolCallId: "tool-1",
      toolName: "extension_demo_audit",
      text: "running",
      metadata: { extensionId: "demo" }
    });
    applyCrewCoderEvent(state, {
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "extension_demo_audit",
      result: {
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "extension_demo_audit",
        content: [{ type: "text", text: "done" }],
        isError: false,
        timestamp: 1,
        details: { extensionId: "demo", renderer: "audit.summary" }
      },
      isError: false,
      metadata: { renderer: "audit.summary" }
    });

    expect(state.blocks.at(-1)).toMatchObject({
      type: "tool",
      id: "tool-1",
      name: "extension_demo_audit",
      status: "done",
      args: { scope: "src" },
      text: "running",
      metadata: { source: "extension", extensionId: "demo", renderer: "audit.summary" }
    });
  });

  it("tracks checkpoint creation without adding a transcript block", () => {
    const state = createInitialState();
    const initialBlocks = [...state.blocks];

    applyCrewCoderEvent(state, {
      type: "checkpoint_created",
      checkpointId: "checkpoint_1",
      sessionId: "session_1",
      reason: "Before write",
      toolCallId: "call_1",
      toolName: "write",
      fileCount: 3,
      totalBytes: 120,
      truncated: false
    });

    expect(state.checkpoints).toEqual([{ id: "checkpoint_1", sessionId: "session_1", reason: "Before write", toolCallId: "call_1", toolName: "write", fileCount: 3, totalBytes: 120, truncated: false }]);
    expect(state.blocks).toEqual(initialBlocks);
  });

  it("logs checkpoint restore events when system logs are enabled", () => {
    process.env.CREWCODER_TUI_SYSTEM_LOGS = "1";
    const state = createInitialState();

    applyCrewCoderEvent(state, { type: "checkpoint_restored", checkpointId: "checkpoint_1", sessionId: "session_1", restoredFiles: 2, deletedFiles: 1, restoredAt: "now" });

    expect(state.blocks.at(-1)).toEqual({ type: "system", text: "checkpoint restored: checkpoint_1 · restored 2 · deleted 1" });
  });

  it("tracks active extension safety policies", () => {
    const state = createInitialState();

    applyCrewCoderEvent(state, {
      type: "extension_safety_policies",
      policies: [{ extensionId: "safety", policyId: "env", title: "Protect env", action: "block", paths: [".env*"], tools: [], commands: [] }]
    });

    expect(state.safetyPolicies).toEqual([{ extensionId: "safety", policyId: "env", title: "Protect env", action: "block", paths: [".env*"], tools: [], commands: [] }]);
  });

  it("tracks approval cards from pending to resolved", () => {
    const state = createInitialState();

    applyCrewCoderEvent(state, {
      type: "approval_required",
      approvalId: "approval_call_1",
      toolCallId: "call_1",
      toolName: "write",
      risk: "review",
      reason: "write may modify project files.",
      args: { path: "README.md" }
    });
    applyCrewCoderEvent(state, {
      type: "approval_resolved",
      approvalId: "approval_call_1",
      approved: true,
      reason: "Approved from TUI control channel."
    });

    expect(state.blocks.at(-1)).toEqual({
      type: "approval",
      id: "approval_call_1",
      toolCallId: "call_1",
      toolName: "write",
      risk: "review",
      text: "write may modify project files.",
      args: { path: "README.md" },
      status: "approved",
      resolutionReason: "Approved from TUI control channel."
    });
  });

  it("marks compaction progress failures visibly", () => {
    const state = createInitialState();

    applyCrewCoderEvent(state, { type: "session_compaction_progress", phase: "failed", percent: 100, message: "Compaction failed" });

    expect(state.blocks.at(-1)).toMatchObject({ type: "compaction", status: "failed", percent: 100, message: "Compaction failed" });
  });

  it("hides system log events by default", () => {
    const state = createInitialState();

    applyCrewCoderEvent(state, { type: "provider_start", providerId: "codex", model: "gpt" });

    expect(state.blocks).toEqual([{ type: "system", text: "Tip: /help\n  Show help for interactive commands" }]);
  });

  it("shows system log events when debug logs are enabled", () => {
    process.env.CREWCODER_TUI_SYSTEM_LOGS = "1";
    const state = createInitialState();

    applyCrewCoderEvent(state, { type: "provider_start", providerId: "codex", model: "gpt" });

    const last = state.blocks.at(-1);
    expect(last).toMatchObject({ type: "system" });
    if (last?.type !== "system") throw new Error("expected system log block");
    expect(last.text).toContain("codex");
  });

  it("preserves user message background for rendering", () => {
    const state = createInitialState();

    applyCrewCoderEvent(state, {
      type: "message_end",
      message: {
        role: "user",
        content: [{ type: "text", text: "hello" }],
        background: ["repoRoot: /tmp/project"],
        timestamp: 1
      }
    });

    expect(state.blocks.at(-1)).toEqual({ type: "user", text: "hello", background: ["repoRoot: /tmp/project"] });
  });

  it("hydrates a selected session from agent_end messages when the viewport is empty", () => {
    const state = createInitialState();
    state.blocks = [];
    state.running = true;

    applyCrewCoderEvent(state, {
      type: "agent_end",
      sessionId: "session_loaded",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "original request" }],
          background: ["repoRoot: /tmp/project"],
          timestamp: 1
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "original answer" }],
          stopReason: "end",
          timestamp: 2
        },
        {
          role: "toolResult",
          toolCallId: "tool-1",
          toolName: "read",
          content: [{ type: "text", text: "file contents" }],
          isError: false,
          timestamp: 3,
          details: { extensionId: "demo", renderer: "file.preview" }
        }
      ]
    });

    expect(state.running).toBe(false);
    expect(state.blocks).toEqual([
      { type: "user", text: "original request" },
      { type: "assistant", text: "original answer" },
      { type: "tool", id: "tool-1", name: "read", status: "done", text: "file contents", metadata: { extensionId: "demo", renderer: "file.preview" } }
    ]);
  });

  it("does not rehydrate agent_end messages over an active conversation", () => {
    const state = createInitialState();
    state.blocks.push({ type: "user", text: "new prompt" });

    applyCrewCoderEvent(state, {
      type: "agent_end",
      sessionId: "session_current",
      messages: [
        { role: "user", content: [{ type: "text", text: "new prompt" }], timestamp: 1 }
      ]
    });

    expect(state.blocks.filter((block) => block.type === "user")).toHaveLength(1);
  });

  it("does not re-render a multi-segment streamed assistant turn at message_end", () => {
    const state = createInitialState();

    applyCrewCoderEvent(state, { type: "assistant_delta", text: "Let me check the file." });
    applyCrewCoderEvent(state, { type: "tool_execution_start", toolCallId: "t1", toolName: "Read", args: {} });
    applyCrewCoderEvent(state, { type: "tool_execution_end", toolCallId: "t1", toolName: "Read", isError: false, result: { role: "toolResult", content: [{ type: "text", text: "ok" }] } });
    applyCrewCoderEvent(state, { type: "assistant_delta", text: "Here is the answer." });
    applyCrewCoderEvent(state, {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "Let me check the file.\n\nHere is the answer." }], timestamp: 1 }
    });

    const assistantBlocks = state.blocks.filter((block) => block.type === "assistant");
    expect(assistantBlocks.map((block) => block.text)).toEqual(["Let me check the file.", "Here is the answer."]);
  });

  it("attaches model throughput to the final streamed assistant block", () => {
    const state = createInitialState();

    applyCrewCoderEvent(state, { type: "assistant_delta", text: "First segment." });
    applyCrewCoderEvent(state, { type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: {} });
    applyCrewCoderEvent(state, { type: "assistant_delta", text: "Final segment." });
    applyCrewCoderEvent(state, {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "First segment.\n\nFinal segment." }] },
      durationMs: 2_000,
      outputTokens: 50
    });

    const assistantBlocks = state.blocks.filter((block) => block.type === "assistant");
    expect(assistantBlocks).toHaveLength(2);
    expect(assistantBlocks[0]?.tokensPerSecond).toBeUndefined();
    expect(assistantBlocks[1]?.tokensPerSecond).toBe(25);
  });

  it("still renders assistant text at message_end when nothing was streamed", () => {
    const state = createInitialState();

    applyCrewCoderEvent(state, {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "replayed answer" }], timestamp: 1 }
    });

    expect(state.blocks.filter((block) => block.type === "assistant").map((block) => block.text)).toEqual(["replayed answer"]);
  });

  it("resets the streamed-turn guard between assistant turns", () => {
    const state = createInitialState();

    applyCrewCoderEvent(state, { type: "assistant_delta", text: "streamed turn" });
    applyCrewCoderEvent(state, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "streamed turn" }], timestamp: 1 } });
    applyCrewCoderEvent(state, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "synthetic follow-up" }], timestamp: 2 } });

    expect(state.blocks.filter((block) => block.type === "assistant").map((block) => block.text)).toEqual(["streamed turn", "synthetic follow-up"]);
  });
});
