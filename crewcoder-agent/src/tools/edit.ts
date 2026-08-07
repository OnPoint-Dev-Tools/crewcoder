import type { ToolDefinition } from "../core/tool-types.js";
import { textResult } from "../core/tool-types.js";
import { resolveInsideCwd, relativeToCwd } from "./path-utils.js";
import { readTextFile, writeTextFile } from "./text-file-io.js";

type Args = { path: string; find: string; replace: string; replaceAll: boolean };

export const editTool: ToolDefinition<Args> = {
  name: "edit",
  description: "Edit a file by replacing exact text. A single replacement must be unique; use replaceAll only when every occurrence is intentionally targeted.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative path, or an absolute path inside a session external directory." },
      find: { type: "string", description: "Exact text to find. Must be unique unless replaceAll is true." },
      replace: { type: "string", description: "Replacement text." },
      replaceAll: { type: "boolean", description: "Replace every occurrence instead of requiring one unique occurrence." }
    },
    required: ["path", "find", "replace"],
    additionalProperties: false
  },
  executionMode: "sequential",
  isMutation: true,
  parse(args) {
    return {
      path: String(args.path ?? ""),
      find: String(args.find ?? ""),
      replace: String(args.replace ?? ""),
      replaceAll: Boolean(args.replaceAll)
    };
  },
  async execute(args, context, signal) {
    if (!args.find) throw new Error("find text is required");
    if (args.find === args.replace) throw new Error(`No changes made to ${args.path}; find and replace text are identical`);
    if (signal?.aborted) throw new Error("Operation aborted");
    const file = resolveInsideCwd(context.cwd, args.path, context.externalDirectories);
    const original = await readTextFile(context, file);
    if (signal?.aborted) throw new Error("Operation aborted");
    const occurrences = countOccurrences(original, args.find);
    if (occurrences === 0) throw new Error(`Could not find target text in ${args.path}`);
    if (!args.replaceAll && occurrences > 1) {
      throw new Error(`Found ${occurrences} occurrences of the target text in ${args.path}; provide more context to make it unique or set replaceAll=true`);
    }
    const next = args.replaceAll ? original.split(args.find).join(args.replace) : original.replace(args.find, args.replace);
    await writeTextFile(context, file, next);
    const rel = relativeToCwd(context.cwd, file);
    context.mutationLog.push(rel);
    return textResult(`Edited ${rel}`, { path: rel, replacements: args.replaceAll ? occurrences : 1, replaceAll: args.replaceAll });
  }
};

function countOccurrences(content: string, target: string): number {
  let count = 0;
  let index = content.indexOf(target);
  while (index !== -1) {
    count += 1;
    index = content.indexOf(target, index + target.length);
  }
  return count;
}
