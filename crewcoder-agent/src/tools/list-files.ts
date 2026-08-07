import fs from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition } from "../core/tool-types.js";
import { textResult } from "../core/tool-types.js";
import { resolveInsideCwd, relativeToCwd } from "./path-utils.js";
import { DEFAULT_TOOL_OUTPUT_BYTES, truncateToolOutputHead } from "./tool-output-limits.js";

type Args = { path?: string; maxFiles: number };

const ignored = new Set(["node_modules", ".git", "dist", "build", ".next", "target"]);

export const listFilesTool: ToolDefinition<Args> = {
  name: "listFiles",
  description: "List files recursively under the workspace or a session external directory. Results are sorted and capped by count and 50KB of model-visible output.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative directory or absolute directory inside a session external root." },
      maxFiles: { type: "integer", description: "Maximum number of files to return.", minimum: 1, maximum: 2000 }
    },
    additionalProperties: false
  },
  executionMode: "parallel",
  parse(args) {
    return {
      path: typeof args.path === "string" ? args.path : ".",
      maxFiles: typeof args.maxFiles === "number" ? Math.min(Math.max(Math.floor(args.maxFiles), 1), 2000) : 200
    };
  },
  async execute(args, context, signal) {
    const root = resolveInsideCwd(context.cwd, args.path ?? ".", context.externalDirectories);
    const files: string[] = [];
    let countLimitReached = false;

    async function walk(dir: string): Promise<void> {
      if (signal?.aborted) throw new Error("Operation aborted");
      const entries = await fs.readdir(dir, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (files.length >= args.maxFiles) {
          countLimitReached = true;
          return;
        }
        if (ignored.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else files.push(relativeToCwd(context.cwd, full));
      }
    }

    await walk(root);
    const truncation = truncateToolOutputHead(files.join("\n"), { maxBytes: DEFAULT_TOOL_OUTPUT_BYTES, maxLines: Number.MAX_SAFE_INTEGER });
    const notices: string[] = [];
    if (countLimitReached) notices.push(`${args.maxFiles} file limit reached; increase maxFiles or narrow the path`);
    if (truncation.truncated) notices.push("50KB output limit reached; narrow the path");
    const output = truncation.text || "(no files)";
    const text = notices.length ? `${output}\n\n[${notices.join(". ")}.]` : output;
    return textResult(text, { count: files.length, truncated: notices.length > 0 });
  }
};
