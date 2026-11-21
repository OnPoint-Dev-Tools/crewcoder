import fs from "node:fs/promises";
import path from "node:path";
import { anchorKey, findAnchor, isEditTool, snippetEdits, type LineAnchors } from "./tool-diff.js";
import type { ToolBlock } from "./transcript.js";

/** Reads a workspace file's text, or undefined when it cannot or should not be read. */
export type FileReader = (absolutePath: string) => Promise<string | undefined>;

/** Files above this are not read just to number a diff. */
const MAX_ANCHOR_FILE_BYTES = 4 * 1024 * 1024;

export const readLocalFile: FileReader = async (absolutePath) => {
  try {
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile() || stat.size > MAX_ANCHOR_FILE_BYTES) return undefined;
    return await fs.readFile(absolutePath, "utf8");
  } catch {
    return undefined;
  }
};

/**
 * Where each find/replace edit of a finished tool call landed in its file, so
 * its diff gets real line numbers. Read once, right after the tool ends: later
 * edits move lines, and the diff should show where this edit happened. An edit
 * whose new text is not found (deleted lines, a later rewrite) gets no anchor
 * and renders as a plain +/- diff.
 */
export async function computeLineAnchors(block: ToolBlock, cwd: string, read: FileReader = readLocalFile): Promise<LineAnchors | undefined> {
  if (block.status !== "done" || !isEditTool(block)) return undefined;
  const edits = snippetEdits(block);
  if (edits.length === 0) return undefined;
  const files = new Map<string, Promise<string | undefined>>();
  const anchors = new Map<string, number>();
  for (const edit of edits) {
    const file = path.resolve(cwd, edit.path);
    if (!files.has(file)) files.set(file, read(file));
    const text = await files.get(file);
    const line = text === undefined ? undefined : findAnchor(text, edit.after);
    if (line !== undefined) anchors.set(anchorKey(edit), line);
  }
  return anchors.size > 0 ? anchors : undefined;
}
