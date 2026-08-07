import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import type { ToolDefinition } from "../core/tool-types.js";
import { textResult } from "../core/tool-types.js";
import { relativeToCwd, resolveInsideCwd } from "./path-utils.js";

type Args = { path: string; symbol: string; body: string };
type BodyMatch = { body: ts.Block; displayName: string };

const scriptKinds: Record<string, ts.ScriptKind> = {
  ".ts": ts.ScriptKind.TS,
  ".tsx": ts.ScriptKind.TSX,
  ".js": ts.ScriptKind.JS,
  ".jsx": ts.ScriptKind.JSX
};

export const editSymbolTool: ToolDefinition<Args> = {
  name: "edit_symbol",
  description: "Replace one TypeScript/JavaScript function or method body by AST symbol lookup while preserving the surrounding file formatting.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative file or absolute file inside a session external root." },
      symbol: { type: "string", description: "Function name, method name, or qualified ClassName.method name." },
      body: { type: "string", description: "New function body statements, without the outer braces." }
    },
    required: ["path", "symbol", "body"],
    additionalProperties: false
  },
  executionMode: "sequential",
  isMutation: true,
  parse(args) { return { path: String(args.path ?? ""), symbol: String(args.symbol ?? ""), body: String(args.body ?? "") }; },
  async execute(args, context) {
    if (!args.symbol.trim()) throw new Error("symbol is required");
    const file = resolveInsideCwd(context.cwd, args.path, context.externalDirectories);
    const kind = scriptKinds[path.extname(file).toLowerCase()];
    if (kind === undefined) throw new Error("edit_symbol currently supports TypeScript and JavaScript files (.ts, .tsx, .js, .jsx)");
    const original = await fs.readFile(file, "utf8");
    const source = ts.createSourceFile(file, original, ts.ScriptTarget.Latest, true, kind);
    assertParseable(source, "Existing file has syntax errors");
    const matches = findBodies(source, args.symbol);
    if (matches.length === 0) throw new Error(`Could not find function symbol ${args.symbol} in ${args.path}`);
    if (matches.length > 1) throw new Error(`Symbol ${args.symbol} is ambiguous (${matches.length} function bodies found); use ClassName.method when applicable`);
    const match = matches[0]!;
    const replacement = formatBody(args.body, original, match.body);
    const next = original.slice(0, match.body.getStart(source)) + replacement + original.slice(match.body.getEnd());
    assertParseable(ts.createSourceFile(file, next, ts.ScriptTarget.Latest, true, kind), "Replacement produced invalid syntax");
    await fs.writeFile(file, next, "utf8");
    const relative = relativeToCwd(context.cwd, file);
    context.mutationLog.push(relative);
    return textResult(`Edited symbol ${match.displayName} in ${relative}`, { path: relative, symbol: match.displayName });
  }
};

function findBodies(source: ts.SourceFile, target: string): BodyMatch[] {
  const matches: BodyMatch[] = [];
  const visit = (node: ts.Node, className?: string): void => {
    let nextClass = className;
    if (ts.isClassDeclaration(node) && node.name) nextClass = node.name.text;
    const name = functionName(node);
    const body = functionBody(node);
    if (name && body) {
      const qualified = nextClass && isClassMember(node) ? `${nextClass}.${name}` : name;
      if (target === name || target === qualified) matches.push({ body, displayName: qualified });
    }
    ts.forEachChild(node, (child) => visit(child, nextClass));
  };
  visit(source);
  return matches;
}

function functionName(node: ts.Node): string | undefined {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) && node.name) return node.name.getText();
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) return node.name.text;
  return undefined;
}

function functionBody(node: ts.Node): ts.Block | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) return node.body;
  if (ts.isVariableDeclaration(node) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) && ts.isBlock(node.initializer.body)) return node.initializer.body;
  return undefined;
}

function isClassMember(node: ts.Node): boolean { return ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node); }

function formatBody(body: string, source: string, existing: ts.Block): string {
  const lineStart = source.lastIndexOf("\n", existing.getStart()) + 1;
  const baseIndent = /^\s*/.exec(source.slice(lineStart, existing.getStart()))?.[0] ?? "";
  const indentUnit = detectIndent(source, existing) ?? "  ";
  const trimmed = body.replace(/^\s*\n/, "").replace(/\s+$/, "");
  if (!trimmed) return "{}";
  const lines = trimmed.split(/\r?\n/);
  const common = commonIndent(lines.filter((line) => line.trim()));
  const normalized = lines.map((line) => `${baseIndent}${indentUnit}${line.slice(Math.min(common, line.length))}`).join("\n");
  return `{\n${normalized}\n${baseIndent}}`;
}

function detectIndent(source: string, body: ts.Block): string | undefined {
  const inside = source.slice(body.getStart() + 1, body.getEnd() - 1);
  const match = /\n([ \t]+)\S/.exec(inside);
  if (!match) return undefined;
  const closingLineStart = source.lastIndexOf("\n", body.getEnd() - 1) + 1;
  const closingIndent = /^\s*/.exec(source.slice(closingLineStart, body.getEnd()))?.[0] ?? "";
  return match[1]!.slice(closingIndent.length) || undefined;
}

function commonIndent(lines: string[]): number {
  if (!lines.length) return 0;
  return Math.min(...lines.map((line) => /^\s*/.exec(line)?.[0].length ?? 0));
}

function assertParseable(source: ts.SourceFile, prefix: string): void {
  const diagnostic = (source as ts.SourceFile & { readonly parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics[0];
  if (!diagnostic) return;
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  throw new Error(`${prefix}: ${message}`);
}
