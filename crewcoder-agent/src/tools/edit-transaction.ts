import fs from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition } from "../core/tool-types.js";
import { textResult } from "../core/tool-types.js";
import { resolveInsideCwd, relativeToCwd } from "./path-utils.js";
import { truncateToolOutputHead } from "./tool-output-limits.js";

type Edit = { path: string; find: string; replace: string; replaceAll: boolean };
type Args = { edits: Edit[] };
type Replacement = { start: number; end: number; text: string };
type PreparedEdit = Edit & { relativePath: string; replacements: number };
type PreparedFile = { absolutePath: string; relativePath: string; original: string; next: string; edits: PreparedEdit[] };

export const editTransactionTool: ToolDefinition<Args> = {
  name: "edit_transaction",
  description: "Preview and apply exact replacements across multiple files as one all-or-nothing transaction. Every target is validated before any file is changed.",
  parameters: {
    type: "object",
    properties: {
      edits: {
        type: "array",
        description: "One or more exact replacements. A file may appear multiple times when its replacement ranges do not overlap.",
        items: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative path, or an absolute path inside a session external directory." },
            find: { type: "string", description: "Exact text to replace." },
            replace: { type: "string", description: "Replacement text." },
            replaceAll: { type: "boolean", description: "Replace every occurrence." }
          },
          required: ["path", "find", "replace"],
          additionalProperties: false
        }
      }
    },
    required: ["edits"],
    additionalProperties: false
  },
  executionMode: "sequential",
  isMutation: true,
  parse(args) {
    if (!Array.isArray(args.edits)) return { edits: [] };
    return {
      edits: args.edits.map((value) => {
        const edit = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
        return { path: String(edit.path ?? ""), find: String(edit.find ?? ""), replace: String(edit.replace ?? ""), replaceAll: Boolean(edit.replaceAll) };
      })
    };
  },
  async execute(args, context) {
    if (args.edits.length === 0) throw new Error("edits must contain at least one edit");
    const files = new Map<string, PreparedFile>();
    const replacementsByFile = new Map<string, Replacement[]>();
    for (const edit of args.edits) {
      if (!edit.path || !edit.find) throw new Error("Each edit requires a path and non-empty find text");
      const absolutePath = resolveInsideCwd(context.cwd, edit.path, context.externalDirectories);
      const relativePath = relativeToCwd(context.cwd, absolutePath);
      let preparedFile = files.get(absolutePath);
      if (!preparedFile) {
        const original = await fs.readFile(absolutePath, "utf8");
        preparedFile = { absolutePath, relativePath, original, next: original, edits: [] };
        files.set(absolutePath, preparedFile);
        replacementsByFile.set(absolutePath, []);
      }

      const matches: Replacement[] = [];
      let start = preparedFile.original.indexOf(edit.find);
      while (start !== -1) {
        matches.push({ start, end: start + edit.find.length, text: edit.replace });
        if (!edit.replaceAll) break;
        start = preparedFile.original.indexOf(edit.find, start + edit.find.length);
      }
      if (matches.length === 0) throw new Error(`Could not find target text in ${relativePath}; no files were changed`);
      replacementsByFile.get(absolutePath)?.push(...matches);
      preparedFile.edits.push({ ...edit, relativePath, replacements: matches.length });
    }

    const prepared = [...files.values()];
    for (const file of prepared) {
      const replacements = replacementsByFile.get(file.absolutePath) ?? [];
      replacements.sort((left, right) => left.start - right.start || left.end - right.end);
      for (let index = 1; index < replacements.length; index += 1) {
        const previous = replacements[index - 1];
        const current = replacements[index];
        if (previous && current && current.start < previous.end) {
          throw new Error(`Overlapping replacements in ${file.relativePath}; no files were changed`);
        }
      }
      for (let index = replacements.length - 1; index >= 0; index -= 1) {
        const replacement = replacements[index];
        if (replacement) file.next = file.next.slice(0, replacement.start) + replacement.text + file.next.slice(replacement.end);
      }
    }

    const written: PreparedFile[] = [];
    try {
      for (const file of prepared) {
        const temporary = path.join(path.dirname(file.absolutePath), `.${path.basename(file.absolutePath)}.crewcoder-${process.pid}-${Date.now()}.tmp`);
        await fs.writeFile(temporary, file.next, "utf8");
        await fs.rename(temporary, file.absolutePath);
        written.push(file);
      }
    } catch (error) {
      await Promise.allSettled(written.map((file) => fs.writeFile(file.absolutePath, file.original, "utf8")));
      throw new Error(`Transaction failed and was rolled back: ${error instanceof Error ? error.message : String(error)}`);
    }

    for (const file of prepared) context.mutationLog.push(file.relativePath);
    const preview = prepared.flatMap((file) => file.edits.map((edit) => ({ path: edit.relativePath, replacements: edit.replacements, before: edit.find, after: edit.replace })));
    const summary = preview.map((edit) => `${edit.path} (${edit.replacements} replacement${edit.replacements === 1 ? "" : "s"})\n- ${edit.before}\n+ ${edit.after}`).join("\n\n");
    const truncation = truncateToolOutputHead(summary);
    const notice = truncation.truncated ? "\n\n[Transaction preview truncated at 2,000 lines or 50KB.]" : "";
    return textResult(`Transaction committed across ${prepared.length} files.\n\n${truncation.text}${notice}`, { paths: prepared.map((file) => file.relativePath), preview, transactional: true, previewTruncated: truncation.truncated });
  }
};
