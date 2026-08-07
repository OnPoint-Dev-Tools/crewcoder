/**
 * Maps CrewCoder tool names onto the ACP `ToolKind` vocabulary.
 *
 * Clients key their icons and UI treatment off `kind`, so an unmapped tool
 * degrades to "other" (a generic gear) rather than breaking anything.
 */
import type { ToolKind, ToolCallLocation } from "@agentclientprotocol/sdk";

const TOOL_KINDS: Record<string, ToolKind> = {
  list_files: "read",
  read: "read",
  grep: "search",
  docs: "fetch",
  write: "edit",
  edit: "edit",
  edit_symbol: "edit",
  edit_transaction: "edit",
  create_plugin: "edit",
  create_extension: "edit",
  git_blame: "read",
  git_log: "read",
  git_diff_range: "read",
  git_cherry_pick: "edit",
  lsp_definition: "read",
  lsp_hover: "read",
  lsp_diagnostics: "read",
  bash: "execute",
  background_job: "execute",
  delegate_worker: "think",
  remember: "other",
  validate_plugin: "other",
  list_templates: "read"
};

export function toolKind(toolName: string): ToolKind {
  return TOOL_KINDS[toolName] ?? "other";
}

/** Argument keys that carry a file path, in priority order. */
const PATH_KEYS = ["path", "file", "file_path", "filePath", "target"];

export function toolLocations(args: Record<string, unknown>): ToolCallLocation[] {
  for (const key of PATH_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return [{ path: value }];
  }
  return [];
}

/**
 * Human-readable one-liner for the client's tool row. Clients show this verbatim,
 * so it stays short and prefers the most identifying argument over a generic name.
 */
export function toolTitle(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "bash" || toolName === "background_job") {
    const command = String(args.command ?? "").trim();
    return command ? truncate(command, 120) : "bash";
  }
  if (toolName === "grep") {
    const pattern = String(args.pattern ?? args.query ?? "").trim();
    return pattern ? `grep ${truncate(pattern, 80)}` : "grep";
  }
  const location = toolLocations(args)[0];
  if (location) return `${toolName} ${location.path}`;
  return toolName;
}

function truncate(value: string, max: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}
