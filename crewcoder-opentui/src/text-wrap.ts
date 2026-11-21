import stringWidth from "string-width";

/** Word wrapping in terminal cells, shared by the sidebar and footer alerts. Pure. */

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Word-wrap to `width` terminal cells (wide characters count twice); words
 * longer than a row, such as paths, break between graphemes.
 */
export function wrapCells(value: string, width: number): string[] {
  const columns = Math.max(1, Math.floor(width));
  const lines: string[] = [];
  for (const logical of value.split("\n")) {
    let line = "";
    for (const word of logical.split(/\s+/).filter(Boolean)) {
      if (line && stringWidth(line) + 1 + stringWidth(word) <= columns) {
        line = `${line} ${word}`;
        continue;
      }
      if (line) lines.push(line);
      line = "";
      for (const { segment } of graphemes.segment(word)) {
        if (line && stringWidth(line) + stringWidth(segment) > columns) {
          lines.push(line);
          line = "";
        }
        line += segment;
      }
    }
    lines.push(line);
  }
  return lines;
}

/** Leading indent plus a list marker (`• `, `- `, `* `, `1. `), if any. */
const HANGING_PREFIX = /^(\s*)((?:[•\-*]|\d+[.)])\s+)?/;

/**
 * `wrapCells` for text that keeps its layout: each line's leading indent stays,
 * and a list item's continuation rows hang under its text, not its marker.
 * Blank lines stay. Each row is at most `width` cells.
 */
export function wrapIndented(value: string, width: number): string[] {
  const columns = Math.max(1, Math.floor(width));
  return value.split("\n").flatMap((line) => {
    const prefix = HANGING_PREFIX.exec(line)?.[0] ?? "";
    const hang = stringWidth(prefix);
    // An indent that leaves no room to wrap into is dropped rather than overflowing.
    if (hang >= columns) return wrapCells(line.trim(), columns);
    const rows = wrapCells(line.slice(prefix.length), columns - hang);
    const pad = " ".repeat(hang);
    return rows.map((row, index) => `${index === 0 ? prefix : pad}${row}`);
  });
}
