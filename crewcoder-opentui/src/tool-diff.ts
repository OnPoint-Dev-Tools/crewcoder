import { formatPatch, parsePatch, structuredPatch, type StructuredPatch } from "diff";
import { relativePath, toolKind } from "./tool-presentation.js";
import type { TuiFileDiff } from "@onpoint-dev-tools/crewcoder-tui-core/state/tui-store";
import { normalize, type ToolBlock } from "./transcript.js";

/** One file's change from a tool call, as a single-file unified diff for OpenTUI's `<diff>`. */
export type FileDiff = {
  path: string;
  patch: string;
  added: number;
  removed: number;
  /** Diff body lines (context, added, removed), for collapsing and the plain fallback. */
  body: string[];
  /**
   * Whether hunk line numbers are the file's real ones. A snippet edit (Claude
   * `Edit`, CrewCoder `edit`) only knows its real place once it is anchored in
   * the file (see `SessionController`); until then it renders as plain +/- lines.
   */
  exactLines: boolean;
  /** Shown instead of a diff body: binary files, or changes too large to include. */
  note?: string;
  status?: "added" | "modified";
};

/** A find/replace edit, as given in the tool's arguments (path not yet resolved). */
export type SnippetEdit = { path: string; before: string; after: string };

/** 1-based file line where each snippet edit's new text starts, keyed by `anchorKey`. */
export type LineAnchors = ReadonlyMap<string, number>;

export function anchorKey(edit: SnippetEdit): string {
  return `${edit.path}\u0000${edit.after}`;
}

const CONTEXT_LINES = 3;

/**
 * The file changes a tool call made, read from its arguments, so it works for
 * every provider without the agent's help:
 * - Codex `Codex file change`: `changes[]` with a unified `diff` (or full content for adds);
 * - Claude `Edit` (`old_string`/`new_string`), `MultiEdit` (`edits[]`), `Write` (`content`);
 * - CrewCoder `edit` (`find`/`replace`), `edit_transaction` (`edits[]` with paths), `write`;
 * - otherwise, output that is itself a unified diff.
 * Only edit/write tools get diffs (never shell commands), and only for files
 * they created or modified; deletions are not shown (owner decision).
 * Returns nothing for other tools and for edits that failed.
 */
export function toolDiffs(block: ToolBlock, cwd?: string, anchors?: LineAnchors): FileDiff[] {
  if (!isEditTool(block)) return [];
  const display = (path: string): string => relativePath(normalize(path), cwd);
  // The agent's snapshot diffs are exact (real line numbers); arguments are the fallback.
  if (block.fileDiffs?.length) return block.fileDiffs.map((file) => agentDiff(file, display));
  const args = block.args ?? {};
  if (Array.isArray(args.changes)) return args.changes.flatMap((change) => codexChange(change, display));
  const edits = snippetEdits(block);
  if (edits.length > 0) {
    return edits.map((edit) => snippetDiff(display(edit.path), edit.before, edit.after, anchors?.get(anchorKey(edit))));
  }
  const filePath = stringArg(args, "file_path", "path", "filePath", "notebook_path");
  const content = rawArg(args, "content");
  if (filePath && content !== undefined) return [snippetDiff(display(filePath), "", content, 1)];
  return outputDiffs(block.text ?? "", display);
}

/** A finished-or-running edit/write tool that did not fail. */
export function isEditTool(block: ToolBlock): boolean {
  const kind = toolKind(block.name);
  return block.status !== "error" && (kind === "edit" || kind === "write");
}

/**
 * The find/replace edits in a tool call: Claude `Edit`/`MultiEdit`
 * (`old_string`/`new_string`), CrewCoder `edit` and `edit_transaction`
 * (`find`/`replace`).
 */
export function snippetEdits(block: ToolBlock): SnippetEdit[] {
  const args = block.args ?? {};
  const filePath = stringArg(args, "file_path", "path", "filePath", "notebook_path");
  const entries = Array.isArray(args.edits) ? args.edits.filter(isRecord) : [args];
  return entries.flatMap((entry) => {
    const path = stringArg(entry, "path", "file_path") ?? filePath;
    const before = rawArg(entry, "old_string", "find", "oldText");
    const after = rawArg(entry, "new_string", "replace", "newText");
    return path && before !== undefined && after !== undefined ? [{ path, before, after }] : [];
  });
}

/** 1-based line where `after` starts in the edited file's text, if it is there. */
export function findAnchor(fileText: string, after: string): number | undefined {
  if (!after) return undefined;
  const index = fileText.indexOf(after);
  return index < 0 ? undefined : fileText.slice(0, index).split("\n").length;
}

/** A file from the agent's `file_diff` event: a real git patch, or a note when it has none. */
function agentDiff(file: TuiFileDiff, display: (path: string) => string): FileDiff {
  const path = display(file.path);
  const base = { path, added: file.additions, removed: file.deletions, status: file.status };
  const parsed = file.patch ? parsedDiffs(normalize(file.patch), () => path)[0] : undefined;
  if (parsed) return { ...parsed, ...base };
  const note = file.binary ? "binary file" : file.truncated ? "diff too large to show" : "no text changes";
  return { ...base, patch: "", body: [], exactLines: true, note };
}

/** A Codex `FileUpdateChange`: `{ path, kind: { type: add | delete | update }, diff }`. */
function codexChange(change: unknown, display: (path: string) => string): FileDiff[] {
  if (!isRecord(change)) return [];
  const path = stringArg(change, "path");
  const diff = rawArg(change, "diff", "unified_diff");
  if (!path || diff === undefined) return [];
  const type = isRecord(change.kind) ? stringArg(change.kind, "type") : stringArg(change, "kind");
  if (type === "add") return [{ ...snippetDiff(display(path), "", diff, 1), status: "added" }];
  if (type === "delete") return [];
  const text = normalize(diff);
  // Codex sends hunks without file headers; jsdiff needs them to parse.
  const withHeaders = /^(---|diff --git)/m.test(text) ? text : `--- a/${path}\n+++ b/${path}\n${text}`;
  return parsedDiffs(withHeaders, () => display(path));
}

function outputDiffs(output: string, display: (path: string) => string): FileDiff[] {
  const text = normalize(output);
  if (!/^@@ /m.test(text) || !/^(---|diff --git)/m.test(text)) return [];
  return parsedDiffs(text, (patch) => display(stripPrefix(patch.newFileName ?? patch.oldFileName ?? "")));
}

function parsedDiffs(text: string, pathOf: (patch: StructuredPatch) => string): FileDiff[] {
  try {
    return parsePatch(text)
      // Deleted files (new side /dev/null) are not shown.
      .filter((patch) => patch.hunks.length > 0 && patch.newFileName !== "/dev/null")
      .map((patch) => fromPatch(pathOf(patch), patch, true));
  } catch {
    return [];
  }
}

/**
 * A diff of two snippets. `startLine` is the file line the snippet starts at:
 * hunks are shifted there and get real line numbers. Without it the diff is
 * numbered from the snippet, so it is not exact.
 */
function snippetDiff(path: string, before: string, after: string, startLine: number | undefined): FileDiff {
  const patch = structuredPatch(path, path, asLines(before), asLines(after), undefined, undefined, { context: CONTEXT_LINES });
  const shift = (startLine ?? 1) - 1;
  const hunks = patch.hunks.map((hunk) => ({ ...hunk, oldStart: hunk.oldStart + shift, newStart: hunk.newStart + shift }));
  return fromPatch(path, { ...patch, hunks }, startLine !== undefined);
}

/** Snippets rarely end in a newline; without one jsdiff adds a misleading "No newline at end of file". */
function asLines(text: string): string {
  const normalized = normalize(text);
  return normalized && !normalized.endsWith("\n") ? `${normalized}\n` : normalized;
}

function fromPatch(path: string, patch: StructuredPatch, exactLines: boolean): FileDiff {
  const body = patch.hunks.flatMap((hunk) => hunk.lines).filter((line) => !line.startsWith("\\"));
  return {
    path,
    patch: formatPatch({ ...patch, oldFileName: path, newFileName: path }),
    added: body.filter((line) => line.startsWith("+")).length,
    removed: body.filter((line) => line.startsWith("-")).length,
    body,
    exactLines
  };
}

function stripPrefix(name: string): string {
  return name.replace(/^[ab]\//, "");
}

function stringArg(args: Record<string, unknown>, ...keys: string[]): string | undefined {
  const value = rawArg(args, ...keys);
  return value?.trim() ? value.trim() : undefined;
}

/** A string argument as given (edits must keep their whitespace). */
function rawArg(args: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
