import type { TuiEventBlock, TuiGoal } from "@onpoint-dev-tools/crewcoder-tui-core/state/tui-store";
import { describe, expect, it } from "vitest";
import {
  BACKGROUND_OUTPUT_LINES, blockPanel, isPanelBlock, REVIEW_FILE_LIMIT, REVIEW_ISSUE_LIMIT, type PanelBlock
} from "../block-panels.js";
import { blockToRow } from "../transcript.js";

const texts = (block: PanelBlock): string[] => blockPanel(block).lines.map((line) => line.text);

const goal = (overrides: Partial<TuiGoal> = {}): TuiGoal => ({
  id: "g-1", objective: "Ship the parser", status: "running", provider: "claude", model: "sonnet", cycle: 2, maxTurns: 10, ...overrides
});

describe("isPanelBlock", () => {
  it("routes structured blocks to panels and leaves conversation blocks alone", () => {
    expect(isPanelBlock({ type: "crew", workers: [], completed: false })).toBe(true);
    expect(isPanelBlock({ type: "background_job", bgId: "b", command: "x", status: "running", output: "" })).toBe(true);
    expect(isPanelBlock({ type: "assistant", text: "a" })).toBe(false);
    expect(isPanelBlock({ type: "tool", name: "bash", status: "done" })).toBe(false);
  });
});

describe("crew panel", () => {
  it("lists every worker with its state while the crew runs", () => {
    const panel = blockPanel({
      type: "crew",
      completed: false,
      workers: [
        { name: "planner", status: "completed", sessionId: "s-1" },
        { name: "builder", status: "running" },
        { name: "reviewer", status: "pending" }
      ]
    });
    expect(panel).toMatchObject({ title: "Crew running", tone: "primary", live: true, meta: "3 agents · 1 active" });
    expect(panel.lines.map((line) => [line.text, line.marker])).toEqual([
      ["planner", { glyph: "✓", tone: "success" }],
      ["builder", "spinner"],
      ["reviewer", { glyph: "○", tone: "muted" }]
    ]);
    // Session ids are internal; the roster names workers only.
    expect(JSON.stringify(panel)).not.toContain("s-1");
  });

  it("shows failures and their errors once finished", () => {
    const panel = blockPanel({ type: "crew", completed: true, workers: [{ name: "builder", status: "failed", error: "tests failed" }] });
    expect(panel).toMatchObject({ title: "Crew finished with failures", tone: "error", live: false, meta: "1 agent" });
    expect(texts({ type: "crew", completed: true, workers: [{ name: "builder", status: "failed", error: "tests failed" }] })).toEqual(["builder", "tests failed"]);
    expect(blockPanel({ type: "crew", completed: true, workers: [{ name: "a", status: "completed" }] })).toMatchObject({ title: "Crew complete", tone: "success" });
    expect(texts({ type: "crew", completed: false, workers: [] })).toEqual(["No workers"]);
  });
});

describe("goal panel", () => {
  it("shows status, turn, objective, maker, and verifier", () => {
    const panel = blockPanel({ type: "goal", goal: goal({ checkModel: "haiku", timeoutMinutes: 30 }) });
    expect(panel).toMatchObject({ title: "Goal · running", tone: "primary", live: true, meta: "g-1 · turn 2/10" });
    expect(panel.lines.map((line) => line.text)).toEqual(["Ship the parser", "maker claude/sonnet", "verifier claude/haiku · timeout 30m"]);
  });

  it("asks for a durable approval with the commands that resolve it", () => {
    const panel = blockPanel({ type: "goal", goal: goal({ status: "awaiting_approval", pendingApproval: { toolName: "bash", reason: "rm -rf build" } }) });
    expect(panel).toMatchObject({ title: "Goal · awaiting approval", tone: "warning", live: false });
    expect(panel.lines.map((line) => line.text)).toContain("Needs approval for bash: rm -rf build");
    expect(panel.lines.map((line) => line.text)).toContain("/goal approve or /goal deny");
  });

  it("shows the verdict, completion summary, evidence, pause reasons, and errors", () => {
    const done = blockPanel({ type: "goal", goal: goal({
      status: "completed", maxTurns: undefined, completionSummary: "Parser shipped", completionEvidence: "npm test passed",
      lastCheck: { verdict: "complete", reason: "all checks green", model: "haiku" }
    }) });
    expect(done).toMatchObject({ tone: "success", live: false, meta: "g-1 · turn 2" });
    expect(done.lines.map((line) => line.text)).toEqual(expect.arrayContaining([
      "Last check (haiku): complete — all checks green", "Parser shipped", "Evidence: npm test passed"
    ]));
    expect(texts({ type: "goal", goal: goal({ status: "paused", pauseReason: "budget" }) })).toContain("Paused: budget");
    expect(blockPanel({ type: "goal", goal: goal({ status: "failed", error: "provider down" }) }).lines.at(-1)).toMatchObject({ text: "provider down", tone: "error" });
  });
});

describe("review summary panel", () => {
  it("lists changed files and issue references with their sources", () => {
    const panel = blockPanel({ type: "review_summary", summary: {
      branch: "feat/x", clean: false, changedFiles: ["src/a.ts"],
      issueReferences: [{ id: "1", source: "branch", text: "#42", url: "https://example.com/42" }]
    } });
    expect(panel).toMatchObject({ title: "Review summary", tone: "warning", meta: "feat/x · 1 changed file" });
    expect(panel.lines.map((line) => line.text)).toEqual(["Changed files", "src/a.ts", "Issues", "#42 (branch) https://example.com/42"]);
  });

  it("bounds long lists and says when there are no issues", () => {
    const files = Array.from({ length: REVIEW_FILE_LIMIT + 3 }, (_, index) => `f${index}`);
    const issues = Array.from({ length: REVIEW_ISSUE_LIMIT + 2 }, (_, index) => ({ id: String(index), source: "commit", text: `#${index}` }));
    const lines = texts({ type: "review_summary", summary: { clean: false, changedFiles: files, issueReferences: issues } });
    expect(lines).toContain("… 3 more");
    expect(lines).toContain("… 2 more");
    expect(lines).not.toContain(`f${REVIEW_FILE_LIMIT}`);

    const clean = blockPanel({ type: "review_summary", summary: { clean: true, changedFiles: [], issueReferences: [] } });
    expect(clean).toMatchObject({ tone: "success", meta: "(no branch) · clean" });
    expect(clean.lines.map((line) => line.text)).toEqual(["No issue references found in the branch, recent commits, or git status."]);
  });
});

describe("why panel", () => {
  it("never makes a transcript readout look like a model explanation", () => {
    const model = blockPanel({ type: "why", decision: { explanation: "I ran tests first.", source: "model", toolCalls: ["bash"], changedFiles: ["a.ts"] } });
    const readout = blockPanel({ type: "why", decision: { explanation: "Ran bash.", source: "transcript", fallbackReason: "auth expired", toolCalls: [], changedFiles: [] } });
    expect(model).toMatchObject({ title: "Why · model explanation", tone: "info" });
    expect(model.lines.map((line) => line.text)).toEqual(["I ran tests first.", "Tools: bash", "Files: a.ts"]);
    expect(readout).toMatchObject({ title: "Why · transcript readout", tone: "warning" });
    expect(readout.lines[0]).toMatchObject({ text: "The model explainer was not used: auth expired", tone: "warning" });
  });
});

describe("background job panel", () => {
  it("shows the command and waits for output while running", () => {
    const panel = blockPanel({ type: "background_job", bgId: "bg-1", command: "npm run dev", status: "running", output: "" });
    expect(panel).toMatchObject({ title: "Background job · running", tone: "warning", live: true, meta: "bg-1" });
    expect(panel.lines.map((line) => line.text)).toEqual(["npm run dev", "(waiting for output)"]);
  });

  it("keeps the newest output lines, strips terminal controls, and shows the exit code", () => {
    const output = `${Array.from({ length: BACKGROUND_OUTPUT_LINES + 4 }, (_, index) => `\x1b[32mline ${index}\x1b[0m`).join("\r\n")}\n`;
    const panel = blockPanel({ type: "background_job", bgId: "bg-1", command: "make", status: "failed", output, exitCode: 2 });
    expect(panel).toMatchObject({ title: "Background job · failed", tone: "error", live: false, meta: "bg-1 · exit 2" });
    const lines = panel.lines.map((line) => line.text);
    expect(lines[1]).toBe("… 4 earlier lines");
    expect(lines.at(-1)).toBe(`line ${BACKGROUND_OUTPUT_LINES + 3}`);
    expect(lines).not.toContain("line 3");
    expect(lines.join("\n")).not.toContain("\x1b");
    expect(texts({ type: "background_job", bgId: "b", command: "true", status: "completed", output: "", exitCode: 0 })).toEqual(["true", "(no output)"]);
  });
});

describe("validation panel", () => {
  it("shows the target and every error and warning", () => {
    expect(blockPanel({ type: "validation", target: "plugins/x", status: "running" })).toMatchObject({ title: "Validation · running", live: true, meta: "plugins/x", lines: [] });
    const failed = blockPanel({ type: "validation", target: "plugins/x", status: "failed", errors: ["missing id"], warnings: ["no icon"] });
    expect(failed).toMatchObject({ title: "Validation · failed", tone: "error", live: false });
    expect(failed.lines.map((line) => [line.text, line.marker])).toEqual([
      ["missing id", { glyph: "✗", tone: "error" }],
      ["no icon", { glyph: "⚠", tone: "warning" }]
    ]);
    expect(blockPanel({ type: "validation", target: "p", status: "passed" }).tone).toBe("success");
  });
});

describe("checkpoint panels", () => {
  it("shows a checkpoint's size and its rewind command", () => {
    const panel = blockPanel({ type: "checkpoint", checkpointId: "cp-1", sessionId: "s", reason: "before edit", toolName: "edit", fileCount: 3, totalBytes: 2048, truncated: false });
    expect(panel).toMatchObject({ title: "Checkpoint", meta: "cp-1" });
    expect(panel.lines.map((line) => line.text)).toEqual(["before edit · 3 files · 2.0 KB", "/rewind cp-1 · before edit"]);
  });

  it("colors a checkpoint diff by line sign", () => {
    const panel = blockPanel({ type: "checkpoint_diff", checkpointId: "cp-1", path: "a.ts", lines: ["@@ -1 +1 @@", "-old", "+new"], truncated: true });
    expect(panel.meta).toBe("a.ts · cp-1");
    expect(panel.lines.map((line) => [line.text, line.tone])).toEqual([["@@ -1 +1 @@", "muted"], ["-old", "error"], ["+new", "success"], ["(truncated)", "muted"]]);
  });
});

describe("blockToRow for blocks without a dedicated view", () => {
  it("says live UI is not available here instead of dropping it", () => {
    const block: TuiEventBlock = { type: "live_ui", key: "k", extensionId: "e", contributionId: "c", surface: "transcript", status: "ready", title: "Board" };
    expect(blockToRow(block)).toMatchObject({ label: "LIVE UI", tone: "muted", text: "Board (extension live UI is not available in this UI)" });
  });
});
