import type { TuiEventBlock } from "@onpoint-dev-tools/crewcoder-tui-core/state/tui-store";
import { describe, expect, it } from "vitest";
import { toolKind, toolPresentation } from "../tool-presentation.js";

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

describe("toolPresentation", () => {
  it("stacks a read under its title with a workspace-relative path and no file dump", () => {
    const view = toolPresentation(tool("Read", { file_path: "/repo/src/App.jsx" }, { text: "file contents..." }), "/repo");
    expect(view).toMatchObject({ icon: "📖", title: "Read File", target: "src/App.jsx", layout: "stacked", failed: false });
    expect(view.output).toBeUndefined();
  });

  it("keeps an edit on one line and lists every file of a multi-file edit", () => {
    expect(toolPresentation(tool("edit", { path: "src/App.jsx" }))).toMatchObject({ icon: "±", title: "Edit File", target: "src/App.jsx", layout: "inline" });
    const multi = toolPresentation(tool("mcp__crewcoder__edit_transaction", { edits: [{ path: "a.ts" }, { path: "b.ts" }, { path: "a.ts" }] }));
    expect(multi.target).toBe("a.ts, b.ts");
    expect(toolPresentation(tool("Codex file change", { changes: [{ path: "/w/x.ts", kind: "update" }] }), "/w").target).toBe("x.ts");
  });

  it("shows a command's first line and clamps its output", () => {
    const output = Array.from({ length: 12 }, (_, index) => `line ${index}`).join("\n");
    const view = toolPresentation(tool("Codex command", { command: "npm test\n--watch" }, { text: output }));
    expect(view).toMatchObject({ icon: "💻", title: "Run Command", target: "npm test", layout: "stacked" });
    expect(view.output?.split("\n")).toHaveLength(9);
    expect(view.output).toContain("… 4 more lines");
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

  it("strips terminal controls from targets and output", () => {
    const view = toolPresentation(tool("bash", { command: "echo \x1b[31mhi" }, { text: "\x1b[32mok\x1b[0m" }));
    expect(view.target).toBe("echo hi");
    expect(view.output).toBe("ok");
  });
});
