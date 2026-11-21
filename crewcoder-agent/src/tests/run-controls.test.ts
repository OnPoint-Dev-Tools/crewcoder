import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assistantText } from "../core/messages.js";
import type { AgentEvent } from "../core/events.js";
import type { ModelClient } from "../core/model-client.js";
import type { ToolDefinition } from "../core/tool-types.js";
import { createWorker } from "../core/identity.js";
import { createRunControls, type RunControls } from "../core/run-controls.js";
import { runWorkerCrew } from "../core/worker-crews.js";

const control = (message: Record<string, unknown>): void => {
  process.stdin.emit("data", Buffer.from(`${JSON.stringify({ type: "control", ...message })}\n`));
};

let open: RunControls | undefined;
afterEach(() => {
  open?.close();
  open = undefined;
});

describe("createRunControls", () => {
  it("has no approval channel and ignores stdin without a JSON event sink", () => {
    open = createRunControls(undefined);
    control({ action: "follow_up", message: "ignored" });
    expect(open.options.approvalSignal).toBeUndefined();
    expect(open.options.followUpSignal.messages).toEqual([]);
  });

  it("collects approvals, follow-ups, and compaction requests from stdin while open", () => {
    open = createRunControls(() => undefined);
    control({ action: "approval", approvalId: "approval_1", approved: true });
    control({ action: "follow_up", message: "also add tests" });
    control({ action: "compact", preview: true });
    expect(open.options.approvalSignal?.decisions).toEqual([{ approvalId: "approval_1", approved: true }]);
    expect(open.options.followUpSignal.messages).toEqual(["also add tests"]);
    expect(open.options.manualCompactSignal).toEqual({ requested: true, preview: true });

    open.close();
    control({ action: "follow_up", message: "after close" });
    expect(open.options.followUpSignal.messages).toEqual(["also add tests"]);
  });
});

describe("crew runs with run controls", () => {
  it("lets a host approve a worker's gated tool instead of auto-denying it", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-crew-controls-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-home-"));
    const originalHome = process.env.CREWCODER_HOME;
    process.env.CREWCODER_HOME = home;
    try {
      createWorker("builder", { description: "Builds code." });
      let wrote = false;
      const writer: ToolDefinition = {
        name: "write",
        description: "Write a file.",
        isMutation: true,
        parse: (args) => args,
        async execute() {
          wrote = true;
          return { content: [{ type: "text", text: "written" }] };
        }
      };
      let calls = 0;
      const model: ModelClient = {
        async complete() {
          calls += 1;
          if (calls === 1) {
            return { role: "assistant", content: [{ type: "toolCall", id: "w1", name: "write", arguments: { path: "a.ts" } }], stopReason: "tool_calls", timestamp: Date.now() };
          }
          return assistantText("built");
        }
      };
      const events: AgentEvent[] = [];
      // The host (the TUI) answers over stdin when it sees the approval request.
      const sink = (event: AgentEvent): void => {
        events.push(event);
        if (event.type === "approval_required") control({ action: "approval", approvalId: event.approvalId, approved: true });
      };
      open = createRunControls(sink);
      await runWorkerCrew({ prompt: "build it", workers: ["builder"], requestedMode: "general", cwd }, {
        approvalMode: "review",
        tools: [writer],
        ...open.options,
        createModelClient: () => model,
        emit: sink
      });

      expect(wrote).toBe(true);
      expect(events).toContainEqual(expect.objectContaining({ type: "approval_resolved", approvalId: "approval_w1", approved: true }));
      expect(events).toContainEqual(expect.objectContaining({ type: "crew_worker_end", worker: "builder", status: "completed" }));
    } finally {
      if (originalHome === undefined) delete process.env.CREWCODER_HOME;
      else process.env.CREWCODER_HOME = originalHome;
    }
  });
});
