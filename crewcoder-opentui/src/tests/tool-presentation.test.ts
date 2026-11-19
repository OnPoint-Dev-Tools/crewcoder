import type { TuiEventBlock } from "@onpoint-dev-tools/crewcoder-tui-core/state/tui-store";
import { describe, expect, it } from "vitest";
import { clampOutput, COLLAPSED_OUTPUT_LINES, diffLineTone, toolKind, toolPresentation } from "../tool-presentation.js";

type ToolBlock = Extract<TuiEventBlock, { type: "tool" }>;

function tool(name: string, args: Record<string, unknown> = {}, extra: Partial<ToolBlock> = {}): ToolBlock {
  return { type: "tool", name, status: "done", args, ...extra };
}

describe("toolKind", () => {
  it("maps CrewCoder, Claude Code, Codex, and MCP-prefixed names", () => {
    expect(toolKind("read")).toBe("read");
    expect(toolKind("Read")).toBe("read");
    expect(toolKind("edit_symbol")).toBe("edit");
    expect(toolKind("mcp__crewcoder__edit_transaction")).toBe("edit");
    expect(toolKind("Codex file change")).toBe("edit");
    expect(toolKind("Codex command")).toBe("command");
    expect(toolKind("Bash")).toBe("command");
    expect(toolKind("Glob")).toBe("search");
    expect(toolKind("listFiles")).toBe("list");
    expect(toolKind("WebFetch")).toBe("web");
    expect(toolKind("TodoWrite")).toBe("tasks");
    expect(toolKind("mcp__crewcoder__delegateWorker")).toBe("agent");
    expect(toolKind("constructor")).toBe("other");
  });
});

describe("clampOutput", () => {
  const output = Array.from({ length: COLLAPSED_OUTPUT_LINES + 5 }, (_, index) => `line ${index}`).join("\n");

  it("collapses to the first lines and counts the hidden rest", () => {
    const collapsed = clampOutput(output, false);
    expect(collapsed.lines).toHaveLength(COLLAPSED_OUTPUT_LINES);
    expect(collapsed.lines[0]).toBe("line 0");
    expect(collapsed.hidden).toBe(5);
  });

  it("shows everything when expanded or short", () => {
    expect(clampOutput(output, true)).toEqual({ lines: output.split("\n"), hidden: 0 });
    expect(clampOutput("a\nb", false)).toEqual({ lines: ["a", "b"], hidden: 0 });
  });
});

describe("diffLineTone", () => {
  it("reads added, removed, and hunk lines, but not file headers", () => {
    expect(["+a", "-b", "@@ -1 +1 @@", "+++ b/x", "--- a/x", " ctx"].map(diffLineTone)).toEqual(["added", "removed", "hunk", "plain", "plain", "plain"]);
  });
});

describe("toolPresentation", () => {
  it("stacks a read under its title with a workspace-relative path and keeps the file contents", () => {
    const view = toolPresentation(tool("Read", { file_path: "/repo/src/App.jsx" }, { text: "file contents..." }), "/repo");
    expect(view).toMatchObject({ icon: "📖", title: "Read File", target: "src/App.jsx", layout: "stacked", failed: false, diff: false });
    expect(view.output).toBe("file contents...");
  });

  it("highlights a read's contents by the read path, never failures or line-numbered output", () => {
    expect(toolPresentation(tool("Read", { file_path: "/repo/src/App.tsx" }, { text: "export {};" }), "/repo").filetype).toBe("typescriptreact");
    expect(toolPresentation(tool("read", { path: "a.ts" }, { status: "error", text: "ENOENT" })).filetype).toBeUndefined();
    expect(toolPresentation(tool("Read", { file_path: "a.ts" }, { text: "     1→export {};" })).filetype).toBeUndefined();
    expect(toolPresentation(tool("Read", { file_path: "notes.rb" }, { text: "puts 1" })).filetype).toBeUndefined();
    expect(toolPresentation(tool("Bash", { command: "cat a.ts" }, { text: "export {};" })).filetype).toBeUndefined();
  });

  it("marks edit and write output as a diff", () => {
    expect(toolPresentation(tool("Edit", { file_path: "a.ts" }, { text: "-old\n+new" })).diff).toBe(true);
    expect(toolPresentation(tool("Write", { file_path: "a.ts" })).diff).toBe(true);
    expect(toolPresentation(tool("Grep", { pattern: "x" })).diff).toBe(false);
  });

  it("keeps an edit on one line and lists every file of a multi-file edit", () => {
    expect(toolPresentation(tool("edit", { path: "src/App.jsx" }))).toMatchObject({ icon: "±", title: "Edit File", target: "src/App.jsx", layout: "inline" });
    const multi = toolPresentation(tool("mcp__crewcoder__edit_transaction", { edits: [{ path: "a.ts" }, { path: "b.ts" }, { path: "a.ts" }] }));
    expect(multi.target).toBe("a.ts, b.ts");
    expect(toolPresentation(tool("Codex file change", { changes: [{ path: "/w/x.ts", kind: "update" }] }), "/w").target).toBe("x.ts");
  });

  it("shows a command's first line and keeps its whole output", () => {
    const output = Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n");
    const view = toolPresentation(tool("Codex command", { command: "npm test\n--watch" }, { text: output }));
    expect(view).toMatchObject({ icon: "💻", title: "Run Command", target: "npm test", layout: "stacked" });
    expect(view.output).toBe(output);
  });

  it("drops the reducer's placeholder when a tool returned no text", () => {
    expect(toolPresentation(tool("Bash", { command: "true" }, { text: "tool completed: Bash" })).output).toBeUndefined();
  });

  it("always shows a failure's output", () => {
    const view = toolPresentation(tool("read", { path: "missing.ts" }, { status: "error", text: "ENOENT: missing.ts" }));
    expect(view.failed).toBe(true);
    expect(view.output).toBe("ENOENT: missing.ts");
  });

  it("describes searches and unknown tools", () => {
    expect(toolPresentation(tool("Grep", { pattern: "TODO", path: "src" })).target).toBe("TODO in src");
    expect(toolPresentation(tool("WebSearch", { query: "opentui" }))).toMatchObject({ title: "Web Search", target: "opentui" });
    const other = toolPresentation(tool("mcp__crewcoder__remember", { fact: "use pnpm" }, { text: "saved" }));
    expect(other).toMatchObject({ icon: "⚙", title: "remember", target: "use pnpm", output: "saved" });
  });

  it("uses one-cell icons for every tool kind with the text glyph set", () => {
    const names = ["read", "edit", "write", "bash", "grep", "listFiles", "WebFetch", "TodoWrite", "delegateWorker", "mcp__x__remember"];
    const icons = names.map((name) => toolPresentation(tool(name), undefined, "text").icon);
    expect(icons).toEqual(["→", "±", "+", "$", "✱", "≡", "%", "#", "@", "*"]);
    // No emoji or other wide code points, so no terminal can clip them.
    for (const icon of icons) expect(icon).toMatch(/^[ -⿿]$/u);
    // Kinds stay distinguishable without emoji.
    expect(new Set(icons).size).toBe(icons.length);
  });

  it("keeps emoji icons by default", () => {
    expect(toolPresentation(tool("bash"), undefined, "emoji").icon).toBe("💻");
    expect(toolPresentation(tool("bash")).icon).toBe("💻");
  });

  it("strips terminal controls from targets and output", () => {
    const view = toolPresentation(tool("bash", { command: "echo \x1b[31mhi" }, { text: "\x1b[32mok\x1b[0m" }));
    expect(view.target).toBe("echo hi");
    expect(view.output).toBe("ok");
  });
});
