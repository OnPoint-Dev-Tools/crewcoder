import type { TuiEventBlock } from "@onpoint-dev-tools/crewcoder-tui-core/state/tui-store";
import { normalize } from "./transcript.js";

type ToolBlock = Extract<TuiEventBlock, { type: "tool" }>;

export type ToolKind = "read" | "edit" | "write" | "command" | "search" | "list" | "web" | "tasks" | "agent" | "other";

/**
 * How one tool call reads in the transcript: an icon and title, the thing it
 * acted on, and output only where it helps. `stacked` puts the target on its
 * own row under the title (`📖 Read File` / `src/App.jsx`); `inline` keeps it
 * on the title row (`± Edit File: src/App.jsx`).
 */
export type ToolPresentation = {
  kind: ToolKind;
  icon: string;
  title: string;
  target?: string;
  layout: "inline" | "stacked";
  /** Output worth showing under the header: commands, unknown tools, and any failure. */
  output?: string;
  failed: boolean;
};

type KindStyle = { icon: string; title: string; layout: ToolPresentation["layout"]; showOutput: boolean };

const KIND_STYLES: Readonly<Record<ToolKind, KindStyle>> = {
  read: { icon: "📖", title: "Read File", layout: "stacked", showOutput: false },
  edit: { icon: "±", title: "Edit File", layout: "inline", showOutput: false },
  write: { icon: "+", title: "Write File", layout: "inline", showOutput: false },
  command: { icon: "💻", title: "Run Command", layout: "stacked", showOutput: true },
  search: { icon: "🔍", title: "Search", layout: "stacked", showOutput: false },
  list: { icon: "📂", title: "List Files", layout: "stacked", showOutput: false },
  web: { icon: "🌐", title: "Web", layout: "stacked", showOutput: false },
  tasks: { icon: "☑", title: "Update Tasks", layout: "inline", showOutput: false },
  agent: { icon: "🤖", title: "Delegate", layout: "stacked", showOutput: false },
  other: { icon: "⚙", title: "", layout: "inline", showOutput: true }
};

/**
 * Tool names across providers, normalized (MCP `mcp__server__` prefix removed,
 * lower case, no separators): CrewCoder's own tools, Claude Code's, and the
 * Codex app-server's `Codex command` / `Codex file change`.
 */
const KINDS_BY_NAME: Readonly<Record<string, ToolKind>> = {
  read: "read", readfile: "read", view: "read", notebookread: "read",
  edit: "edit", multiedit: "edit", editsymbol: "edit", edittransaction: "edit", codexfilechange: "edit", applypatch: "edit", strreplace: "edit", notebookedit: "edit",
  write: "write", writefile: "write", createfile: "write",
  bash: "command", shell: "command", exec: "command", codexcommand: "command", runcommand: "command", backgroundjob: "command",
  grep: "search", glob: "search", search: "search", codesearch: "search",
  listfiles: "list", ls: "list", list: "list",
  webfetch: "web", websearch: "web", fetch: "web",
  todowrite: "tasks", taskcreate: "tasks", taskupdate: "tasks", tasklist: "tasks", taskget: "tasks", taskdelete: "tasks",
  task: "agent", agent: "agent", delegateworker: "agent"
};

const MAX_OUTPUT_LINES = 8;
const MAX_TARGET_CHARS = 160;

export function toolKind(name: string): ToolKind {
  const key = name.replace(/^mcp__[^_]+(?:_[^_]+)*__/, "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return Object.hasOwn(KINDS_BY_NAME, key) ? KINDS_BY_NAME[key]! : "other";
}

/** `cwd` shortens absolute paths under the workspace to workspace-relative ones. */
export function toolPresentation(block: ToolBlock, cwd?: string): ToolPresentation {
  const kind = toolKind(block.name);
  const style = KIND_STYLES[kind];
  const args = block.args ?? {};
  const failed = block.status === "error";
  // The reducer's stand-in when a tool returned no text says nothing the title does not.
  const raw = normalize(block.text ?? "").trimEnd();
  const text = raw === `tool completed: ${block.name}` ? "" : raw;
  const output = text && (failed || style.showOutput) ? clampLines(text, MAX_OUTPUT_LINES) : undefined;
  const title = kind === "other" ? block.name.replace(/^mcp__[^_]+(?:_[^_]+)*__/, "") : kind === "web" ? webTitle(block.name) : style.title;
  const target = toolTarget(kind, args, cwd);
  return { kind, icon: style.icon, title, target: target ? fit(normalize(target)) : undefined, layout: style.layout, output, failed };
}

function toolTarget(kind: ToolKind, args: Record<string, unknown>, cwd?: string): string | undefined {
  const paths = argPaths(args).map((path) => relativePath(path, cwd));
  switch (kind) {
    case "read":
    case "edit":
    case "write":
    case "list":
      return paths.length ? paths.join(", ") : undefined;
    case "command":
      return firstLine(stringArg(args, "command", "cmd"));
    case "search": {
      const pattern = stringArg(args, "pattern", "query", "regex");
      const where = paths[0] ?? stringArg(args, "glob");
      return pattern && where ? `${pattern} in ${where}` : pattern ?? where;
    }
    case "web":
      return stringArg(args, "url", "query");
    case "agent":
      return stringArg(args, "description", "worker", "subagent_type", "task");
    case "tasks":
      return stringArg(args, "subject");
    case "other":
      return paths[0] ?? firstLine(firstStringArg(args));
  }
}

/** Paths from the argument shapes providers use, including multi-file edits. */
function argPaths(args: Record<string, unknown>): string[] {
  const direct = stringArg(args, "path", "file_path", "filePath", "notebook_path");
  if (direct) return [direct];
  const lists = [args.edits, args.changes].filter(Array.isArray) as unknown[][];
  const paths = lists.flat().map((entry) => (isRecord(entry) ? stringArg(entry, "path", "file_path") : undefined));
  return [...new Set(paths.filter((path): path is string => Boolean(path)))];
}

function relativePath(path: string, cwd?: string): string {
  if (!cwd || cwd === "/") return path;
  const root = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return path.startsWith(root) ? path.slice(root.length) : path;
}

function webTitle(name: string): string {
  return /search/i.test(name) ? "Web Search" : "Fetch";
}

function stringArg(args: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function firstStringArg(args: Record<string, unknown>): string | undefined {
  return Object.values(args).find((value): value is string => typeof value === "string" && value.trim() !== "")?.trim();
}

function firstLine(text: string | undefined): string | undefined {
  return text?.split("\n", 1)[0];
}

function fit(text: string): string {
  return text.length <= MAX_TARGET_CHARS ? text : `${text.slice(0, MAX_TARGET_CHARS - 1)}…`;
}

function clampLines(text: string, max: number): string {
  const lines = text.split("\n");
  return lines.length <= max ? text : [...lines.slice(0, max), `… ${lines.length - max} more lines`].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
