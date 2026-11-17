/**
 * Pure model for the command palette and every picker built on it. The footer
 * sizer, `App`, and `CommandPalette` all derive rows from here so the footer
 * height always equals what renders, and the cursor always indexes the same
 * order the rows are drawn in.
 */
export interface PaletteCommand {
  id: string;
  label: string;
  description?: string;
  group?: string;
  /** Marks the active value (current provider, model, mode, ...). */
  current?: boolean;
}

export type PickerRow =
  | { kind: "header"; label: string }
  | { kind: "item"; item: PaletteCommand; index: number };

export type PickerView = {
  /** Visible rows only (windowed around the cursor). */
  rows: PickerRow[];
  selectedIndex: number;
  total: number;
};

/** Outer border (2) + search box (3) + hint row (1). */
export const COMMAND_PALETTE_CHROME_ROWS = 6;
/** Most list rows a picker shows before it scrolls. */
export const PICKER_MAX_ROWS = 12;

/** Matching items in display order: groups in first-match order, best matches first within each. */
export function pickerEntries(items: readonly PaletteCommand[], query: string): PaletteCommand[] {
  const ranked = items
    .map((item, position) => ({ item, position, score: matchScore(item, query) }))
    .filter((entry) => entry.score !== undefined)
    .sort((left, right) => left.score! - right.score! || left.position - right.position);
  const groups = new Map<string | undefined, PaletteCommand[]>();
  for (const { item } of ranked) {
    const members = groups.get(item.group) ?? [];
    members.push(item);
    groups.set(item.group, members);
  }
  return [...groups.values()].flat();
}

/** Rows for ordered entries: a header before each named group. */
export function pickerRows(entries: readonly PaletteCommand[]): PickerRow[] {
  const rows: PickerRow[] = [];
  let group: string | undefined;
  entries.forEach((item, index) => {
    if (item.group && (index === 0 || item.group !== group)) rows.push({ kind: "header", label: item.group });
    group = item.group;
    rows.push({ kind: "item", item, index });
  });
  return rows;
}

/** List rows that fit a terminal of this height under the palette chrome. */
export function pickerMaxRows(terminalHeight: number): number {
  return Math.max(1, Math.min(PICKER_MAX_ROWS, terminalHeight - COMMAND_PALETTE_CHROME_ROWS));
}

export function pickerView(items: readonly PaletteCommand[], query: string, cursor: number, maxRows: number): PickerView {
  const entries = pickerEntries(items, query);
  const rows = pickerRows(entries);
  const selectedIndex = Math.max(0, Math.min(cursor, entries.length - 1));
  if (rows.length <= maxRows) return { rows, selectedIndex, total: entries.length };
  const selectedRow = rows.findIndex((row) => row.kind === "item" && row.index === selectedIndex);
  const start = Math.max(0, Math.min(selectedRow - Math.floor(maxRows / 2), rows.length - maxRows));
  return { rows: rows.slice(start, start + maxRows), selectedIndex, total: entries.length };
}

/** Rows `CommandPalette` renders for a view: chrome plus list rows, or the single empty/loading row. */
export function pickerHeight(view: PickerView): number {
  return COMMAND_PALETTE_CHROME_ROWS + Math.max(1, view.rows.length);
}

/** Lower is better; undefined when the item does not match. */
function matchScore(item: PaletteCommand, query: string): number | undefined {
  const needle = query.trim().toLowerCase();
  if (!needle) return 0;
  const label = subsequenceScore(item.label.toLowerCase(), needle);
  if (label !== undefined) return label;
  const rest = subsequenceScore(`${item.description ?? ""} ${item.group ?? ""}`.toLowerCase(), needle);
  return rest === undefined ? undefined : 1_000 + rest;
}

/** Gap count of a subsequence match, so tighter and earlier matches rank first. */
function subsequenceScore(source: string, needle: string): number | undefined {
  const direct = source.indexOf(needle);
  if (direct >= 0) return direct;
  let score = 0;
  let last = -1;
  let found = 0;
  for (let index = 0; index < source.length && found < needle.length; index += 1) {
    if (source[index] !== needle[found]) continue;
    score += index - last - 1;
    last = index;
    found += 1;
  }
  return found === needle.length ? 100 + score : undefined;
}
