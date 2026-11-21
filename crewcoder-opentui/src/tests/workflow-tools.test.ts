import { describe, expect, it } from "vitest";
import { findMatches } from "../transcript-search.js";
import type { ToolBlock } from "../transcript.js";
import { CLARIFY_TOOL, PLAN_APPROVAL_HINT, PROPOSE_PLAN_TOOL, workflowTexts, workflowView } from "../workflow-tools.js";

const plan = (args: Record<string, unknown>, status: ToolBlock["status"] = "done"): ToolBlock => ({
  type: "tool", id: "p1", name: PROPOSE_PLAN_TOOL, status, args, text: "Plan proposed. Implementation is still blocked…"
});

describe("workflowView", () => {
  it("draws a plan from its arguments, in legacy order plus investigation and file changes", () => {
    const view = workflowView(plan({
      requirements: "Add search",
      investigation: "App.tsx owns keys",
      fileChanges: [{ action: "modify", path: "src/App.tsx", description: "Wire Ctrl+F", snippet: "const a = 1;" }, { path: "" }, "junk"],
      plan: "1. Model\n2. View",
      acceptanceCriteria: "Tests pass"
    }));
    expect(view?.title).toBe("Proposed plan");
    expect(view?.sections.map((section) => section.heading)).toEqual(["Requirements", "Investigation", "File changes", "Plan", "Acceptance criteria"]);
    expect(view?.hint).toBe(PLAN_APPROVAL_HINT);
    const files = view?.sections.find((section) => section.kind === "files");
    expect(files).toEqual({ kind: "files", heading: "File changes", files: [{ action: "modify", path: "src/App.tsx", description: "Wire Ctrl+F", snippet: "const a = 1;" }] });
  });

  it("shows a plan while the tool still runs (its arguments are already there)", () => {
    expect(workflowView(plan({ requirements: "r", plan: "p" }, "running"))?.sections).toHaveLength(2);
  });

  it("falls back to the tool's text without arguments, and leaves failures to the error view", () => {
    expect(workflowView(plan({}))).toEqual({ title: "Proposed plan", sections: [{ kind: "text", text: "Plan proposed. Implementation is still blocked…" }] });
    expect(workflowView(plan({ requirements: "r" }, "error"))).toBeUndefined();
  });

  it("lists clarify questions, numbered, and ignores other tools", () => {
    const clarify: ToolBlock = { type: "tool", id: "c1", name: CLARIFY_TOOL, status: "done", args: { questions: ["Which file?", " ", "Keep the API?"] }, text: "" };
    const view = workflowView(clarify);
    expect(view?.sections).toEqual([{ kind: "list", items: ["Which file?", "Keep the API?"] }]);
    expect(workflowTexts(view!)).toEqual(["1. Which file?", "2. Keep the API?"]);
    expect(workflowView({ type: "tool", id: "b", name: "bash", status: "done", args: {}, text: "x" })).toBeUndefined();
  });

  it("strips terminal controls from agent text", () => {
    const view = workflowView(plan({ requirements: "red \x1b[31mtext\x1b[0m" }));
    expect(view?.sections[0]).toMatchObject({ text: "red text" });
  });

  it("is what transcript search sees, never the collapsed tool text or the headings", () => {
    const block = plan({ requirements: "needle in requirements", plan: "x" });
    expect(findMatches([block], "needle", "/w")).toEqual([expect.objectContaining({ kind: "text", text: "needle in requirements" })]);
    expect(findMatches([block], "Requirements", "/w")).toEqual([]);
    expect(findMatches([block], "still blocked", "/w")).toEqual([]);
  });
});
