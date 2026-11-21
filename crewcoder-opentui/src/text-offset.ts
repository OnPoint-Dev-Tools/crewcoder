import stringWidth from "string-width";

/**
 * OpenTUI 0.9.2's `<textarea>` `cursorOffset` counts display cells, not
 * UTF-16 units: `😀` and `中` are 2, a combining accent 0, a newline 1, and a
 * tab a fixed 2 (measured against the native edit buffer). These convert
 * between that offset and a JS string index into `plainText`, so string
 * slicing (the `@` token) lines up with the cursor.
 */
const TAB_CELLS = 2;

const segmenter = new Intl.Segmenter();

function cells(grapheme: string): number {
  if (grapheme === "\n") return 1;
  if (grapheme === "\t") return TAB_CELLS;
  return stringWidth(grapheme);
}

/** The JS index of the grapheme boundary at `offset` cells (clamped to the text). */
export function offsetToIndex(text: string, offset: number): number {
  let seen = 0;
  for (const { segment, index } of segmenter.segment(text)) {
    if (seen >= offset) return index;
    seen += cells(segment);
  }
  return text.length;
}

/** The cell offset of JS index `index` (rounded down to a grapheme boundary). */
export function indexToOffset(text: string, index: number): number {
  let seen = 0;
  for (const { segment, index: at } of segmenter.segment(text)) {
    if (at + segment.length > index) break;
    seen += cells(segment);
  }
  return seen;
}
