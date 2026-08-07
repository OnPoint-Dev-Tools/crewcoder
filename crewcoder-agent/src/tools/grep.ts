import fs from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition } from "../core/tool-types.js";
import { textResult } from "../core/tool-types.js";
import { resolveInsideCwd, relativeToCwd } from "./path-utils.js";

type Args = { pattern: string; path?: string; maxMatches: number };

const ignored = new Set(["node_modules", ".git", "dist", "build", ".next", "target"]);
const textExt = new Set([".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".html", ".css", ".rs", ".toml", ".yml", ".yaml", ".txt"]);
const MAX_MATCH_LINE_CHARS = 500;
const MAX_OUTPUT_BYTES = 50 * 1024;

function compilePattern(pattern: string): RegExp {
  try {
    return new RegExp(pattern, "i");
  } catch (error) {
    throw new Error(`Invalid regular expression: ${pattern} (${error instanceof Error ? error.message : String(error)})`);
  }
}

async function searchFile(file: string, cwd: string, regex: RegExp, matches: string[], maxMatches: number, truncation: { line: boolean }): Promise<void> {
  let text = "";
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return;
  }
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length && matches.length < maxMatches; index += 1) {
    const line = lines[index] ?? "";
    if (!regex.test(line)) continue;
    const lineTruncated = line.length > MAX_MATCH_LINE_CHARS;
    if (lineTruncated) truncation.line = true;
    const clipped = lineTruncated ? `${line.slice(0, MAX_MATCH_LINE_CHARS - 1)}…` : line;
    matches.push(`${relativeToCwd(cwd, file)}:${index + 1}: ${clipped}`);
  }
}

async function walk(dir: string, cwd: string, regex: RegExp, matches: string[], maxMatches: number, truncation: { line: boolean }): Promise<void> {
  if (matches.length >= maxMatches) return;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (matches.length >= maxMatches) break;
    if (ignored.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, cwd, regex, matches, maxMatches, truncation);
      continue;
    }
    // Extension filter only applies when scanning a tree; an explicitly named
    // file is always searched.
    if (!textExt.has(path.extname(entry.name))) continue;
    await searchFile(full, cwd, regex, matches, maxMatches, truncation);
  }
}

export const grepTool: ToolDefinition<Args> = {
  name: "grep",
  description: "Search text files for a string or regex pattern. Accepts a directory to search recursively, or a single file. Output is capped at 50KB, and matching lines are capped at 500 characters; narrow the pattern/path or use read for full lines.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Case-insensitive regular expression to search for." },
      path: { type: "string", description: "Workspace-relative path or absolute path inside a session external directory. Defaults to the workspace root." },
      maxMatches: { type: "integer", description: "Maximum number of matches to return.", minimum: 1, maximum: 1000 }
    },
    required: ["pattern"],
    additionalProperties: false
  },
  executionMode: "parallel",
  parse(args) {
    return {
      pattern: String(args.pattern ?? ""),
      path: typeof args.path === "string" ? args.path : ".",
      maxMatches: typeof args.maxMatches === "number" ? args.maxMatches : 100
    };
  },
  async execute(args, context) {
    if (!args.pattern) throw new Error("pattern is required");
    const target = args.path ?? ".";
    const root = resolveInsideCwd(context.cwd, target, context.externalDirectories);
    const regex = compilePattern(args.pattern);
    const matches: string[] = [];
    const truncation = { line: false };

    // The schema accepts a directory OR a file; stat first so a file path does
    // not blow up in readdir with ENOTDIR.
    let stats: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stats = await fs.stat(root);
    } catch {
      throw new Error(`Path not found: ${target}`);
    }

    if (stats.isFile()) await searchFile(root, context.cwd, regex, matches, args.maxMatches, truncation);
    else if (stats.isDirectory()) await walk(root, context.cwd, regex, matches, args.maxMatches, truncation);
    else throw new Error(`Path is neither a file nor a directory: ${target}`);

    const outputLines: string[] = [];
    let outputBytes = 0;
    let outputTruncated = false;
    for (const match of matches) {
      const bytes = Buffer.byteLength(match, "utf8") + (outputLines.length ? 1 : 0);
      if (outputBytes + bytes > MAX_OUTPUT_BYTES) {
        outputTruncated = true;
        break;
      }
      outputLines.push(match);
      outputBytes += bytes;
    }

    const notices: string[] = [];
    if (matches.length >= args.maxMatches) notices.push(`${args.maxMatches} matches limit reached; increase maxMatches or refine the pattern`);
    if (outputTruncated) notices.push("50KB output limit reached; narrow the pattern or path");
    if (truncation.line) notices.push("some lines truncated to 500 characters; use read to inspect the full line");
    const output = outputLines.join("\n") || "(no matches)";
    const text = notices.length ? `${output}\n\n[${notices.join(". ")}]` : output;
    return textResult(text, { count: matches.length, truncated: notices.length > 0 });
  }
};
