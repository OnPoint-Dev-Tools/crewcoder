import { TextBufferRenderable, type Renderable, type ScrollBoxRenderable } from "@opentui/core";
import stringWidth from "string-width";
import { occurrences, type SearchMatch } from "./transcript-search.js";

/**
 * Finds a search match in the laid-out transcript (`docs/TRANSCRIPT.md#search`)
 * through OpenTUI's public renderable tree: each block's box has
 * `blockElementId`, and every text, markdown paragraph, code block, and diff
 * inside it is a `TextBufferRenderable` with its drawn `plainText` and wrapped
 * `lineInfo`. Labels and toggles (`chromeId`) are skipped so occurrence
 * numbers line up with `findMatches`, which never searches them.
 */

/** The id of a block's box in the transcript. */
export function blockElementId(index: number): string {
  return `transcript-block-${index}`;
}

const CHROME_PREFIX = "chrome-";

/** Id for transcript text that is not block content (labels, toggles, headers); search skips it. */
export function chromeId(name: string, index?: number | string): string {
  return index === undefined ? `${CHROME_PREFIX}${name}` : `${CHROME_PREFIX}${name}-${index}`;
}

/**
 * The content row (0 = top of the scrolled content) of the match's line, or
 * undefined when its block is not on screen. Falls back to the block's top row
 * when its drawn text has fewer occurrences than the model (rendered markdown
 * hides markers the source has).
 */
export function locateMatchRow(scroll: ScrollBoxRenderable, match: SearchMatch, query: string): number | undefined {
  const box = scroll.findDescendantById(blockElementId(match.block));
  const origin = scroll.getChildren()[0];
  if (!box || !origin) return undefined;
  const found: Array<{ text: TextBufferRenderable; start: number }> = [];
  collectOccurrences(box, query, found);
  const hit = found[Math.min(match.ordinal, found.length - 1)];
  const top = hit ? hit.text.y + visualRow(hit.text, hit.start) : box.y;
  return top - origin.y;
}

function collectOccurrences(node: Renderable, query: string, found: Array<{ text: TextBufferRenderable; start: number }>): void {
  if (node.id.startsWith(CHROME_PREFIX)) return;
  if (node instanceof TextBufferRenderable) {
    for (const [start] of occurrences(node.plainText, query)) found.push({ text: node, start });
    return;
  }
  for (const child of node.getChildren()) collectOccurrences(child, query, found);
}

/**
 * The wrapped row of character `index` inside a text renderable. `lineStartCols`
 * are display columns counted over the whole text, a newline counting as one.
 */
export function visualRow(text: Pick<TextBufferRenderable, "plainText" | "lineInfo">, index: number): number {
  const before = text.plainText.slice(0, index);
  const column = before.split("\n").reduce((sum, line, at) => sum + stringWidth(line) + (at > 0 ? 1 : 0), 0);
  const starts = text.lineInfo.lineStartCols;
  let row = 0;
  for (const [at, start] of starts.entries()) {
    if (start > column) break;
    row = at;
  }
  return row;
}
