import type { ToolDefinition, ToolResult } from "../core/tool-types.js";
import { textResult } from "../core/tool-types.js";
import { resolveInsideCwd } from "./path-utils.js";
import { LspClient, lspServerForFile } from "./lsp-client.js";
import { truncateToolOutputHead } from "./tool-output-limits.js";

type PositionArgs = { path: string; line: number; character: number };
type DiagnosticsArgs = { path: string };

const positionProperties = {
  path: { type: "string" as const, description: "Workspace-relative source file path." },
  line: { type: "integer" as const, description: "One-based line number.", minimum: 1 },
  character: { type: "integer" as const, description: "Zero-based UTF-16 character offset.", minimum: 0 }
};

async function withLsp(path: string, cwd: string, operation: (client: LspClient, uri: string) => Promise<unknown>): Promise<ToolResult> {
  const file = resolveInsideCwd(cwd, path);
  const spec = lspServerForFile(file);
  const client = new LspClient(cwd, spec);
  try {
    const uri = await client.open(file);
    const result = await operation(client, uri);
    const serialized = JSON.stringify(result ?? null, null, 2);
    const truncation = truncateToolOutputHead(serialized);
    const notice = truncation.truncated ? "\n\n[LSP output truncated at 2,000 lines or 50KB.]" : "";
    return textResult(`${truncation.text}${notice}`, { path, server: spec.command, truncated: truncation.truncated, totalOutputBytes: truncation.totalBytes });
  } finally {
    await client.dispose();
  }
}

export const lspDefinitionTool: ToolDefinition<PositionArgs> = {
  name: "lsp_definition",
  description: "Find the definition of a symbol using the workspace language server.",
  parameters: { type: "object", properties: positionProperties, required: ["path", "line", "character"], additionalProperties: false },
  executionMode: "sequential",
  parse(args) { return parsePosition(args); },
  execute(args, context) {
    return withLsp(args.path, context.cwd, (client, uri) => client.request("textDocument/definition", { textDocument: { uri }, position: { line: args.line - 1, character: args.character } }));
  }
};

export const lspHoverTool: ToolDefinition<PositionArgs> = {
  name: "lsp_hover",
  description: "Show type and documentation information at a source position using the workspace language server.",
  parameters: { type: "object", properties: positionProperties, required: ["path", "line", "character"], additionalProperties: false },
  executionMode: "sequential",
  parse(args) { return parsePosition(args); },
  execute(args, context) {
    return withLsp(args.path, context.cwd, (client, uri) => client.request("textDocument/hover", { textDocument: { uri }, position: { line: args.line - 1, character: args.character } }));
  }
};

export const lspDiagnosticsTool: ToolDefinition<DiagnosticsArgs> = {
  name: "lsp_diagnostics",
  description: "Read diagnostics published for a source file by the workspace language server.",
  parameters: { type: "object", properties: { path: positionProperties.path }, required: ["path"], additionalProperties: false },
  executionMode: "sequential",
  parse(args) { return { path: String(args.path ?? "") }; },
  execute(args, context) { return withLsp(args.path, context.cwd, (client, uri) => client.diagnostics(uri)); }
};

function parsePosition(args: Record<string, unknown>): PositionArgs {
  const line = Number(args.line);
  const character = Number(args.character);
  if (!Number.isInteger(line) || line < 1) throw new Error("line must be a positive integer");
  if (!Number.isInteger(character) || character < 0) throw new Error("character must be a non-negative integer");
  return { path: String(args.path ?? ""), line, character };
}
