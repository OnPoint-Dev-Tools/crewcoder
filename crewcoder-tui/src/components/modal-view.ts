import type { RenderContext } from "../tui/component.js";
import { bg, bold, fg, reset, visibleLength } from "../tui/ansi.js";
import { emptyLine, padRight, truncate } from "../tui/layout.js";

export type ModalRow = { label: string; hint?: string; header?: boolean; alignHint?: boolean };

export type ModalViewOptions = {
  title: string;
  /** When provided, a search line is rendered (empty string shows the placeholder). */
  search?: string;
  placeholder?: string;
  sectionLabel?: string;
  rows: ModalRow[];
  selected: number;
  /** Visual-only highlight; unlike selected it must not change list scrolling. */
  hovered?: number;
  footer?: string;
  emptyText?: string;
};

/**
 * Number of non-list lines a modal body reserves (title, search, section, footer).
 * Used to size the modal box so the list area is snug around its content.
 */
export function modalChromeHeight(opts: { search?: boolean; sectionLabel?: boolean; footer?: boolean }): number {
  let height = 2; // title + blank
  if (opts.search) height += 2; // search + blank
  if (opts.sectionLabel) height += 1;
  if (opts.footer) height += 2; // blank + footer
  return height;
}

/**
 * Renders the inner content of a selection modal in the CrewCoder house style:
 * a title with an `esc` affordance, an optional search line, an optional section
 * header, a list with a full-width highlight bar on the active row, and a footer.
 */
export function renderModalView(ctx: RenderContext, opts: ModalViewOptions): string[] {
  const width = ctx.size.width;
  const height = ctx.size.height;
  const lines: string[] = [];

  lines.push(spread(`${fg(ctx.theme.accent)}${bold()}${opts.title}${reset()}`, `${fg(ctx.theme.muted)}esc${reset()}`, width));
  lines.push(emptyLine(width));

  if (opts.search !== undefined) {
    const value = opts.search;
    const search = value.length
      ? `${fg(ctx.theme.text)} ${truncate(value, Math.max(1, width - 3))}${reset()}${bg(ctx.theme.accent)} ${reset()}`
      : `${fg(ctx.theme.subtle)} ${truncate(opts.placeholder ?? "Search", Math.max(1, width - 2))}${reset()}`;
    const fill = bg(ctx.theme.surfaceAlt);
    const filledSearch = padRight(search, width).replaceAll(reset(), `${reset()}${fill}`);
    lines.push(`${fill}${filledSearch}${reset()}`);
    lines.push(emptyLine(width));
  }

  if (opts.sectionLabel) lines.push(padRight(`${fg(ctx.theme.accent)}${bold()}${opts.sectionLabel}${reset()}`, width));

  const footerReserve = opts.footer ? 2 : 0;
  const listHeight = Math.max(1, height - lines.length - footerReserve);

  if (opts.rows.length === 0) {
    lines.push(padRight(`${fg(ctx.theme.muted)}${opts.emptyText ?? "No matches"}${reset()}`, width));
  } else {
    const start = scrollStart(opts.selected, listHeight, opts.rows.length);
    const view = opts.rows.slice(start, start + listHeight);
    for (let i = 0; i < view.length; i++) {
      const idx = start + i;
      lines.push(renderRow(ctx, view[i]!, idx === (opts.hovered ?? opts.selected), width));
    }
  }

  while (lines.length < height - footerReserve) lines.push(emptyLine(width));

  if (opts.footer) {
    lines.push(emptyLine(width));
    lines.push(padRight(`${fg(ctx.theme.muted)}${truncate(opts.footer, width)}${reset()}`, width));
  }

  while (lines.length < height) lines.push(emptyLine(width));
  return lines.slice(0, height);
}

function renderRow(ctx: RenderContext, row: ModalRow, active: boolean, width: number): string {
  // Section headers are non-selectable labels that group the rows below them.
  if (row.header) {
    const label = truncate(row.label, Math.max(1, width));
    return padRight(`${fg(ctx.theme.accent)}${bold()}${label}${reset()}`, width);
  }
  // Truncate the plain text first, then colorize, so ANSI escape codes are never
  // sliced mid-sequence (which would leak raw escape fragments into the output).
  const indent = "  ";
  const reservedHint = row.alignHint && row.hint ? truncate(row.hint, Math.max(1, width - 5)) : "";
  const labelWidth = reservedHint
    ? Math.max(1, width - indent.length - visibleLength(reservedHint) - 2)
    : Math.max(1, width - indent.length);
  const label = truncate(row.label, labelWidth);
  const available = width - indent.length - visibleLength(label) - 2;
  const hint = reservedHint || (row.hint && available > 1 ? truncate(row.hint, available) : "");
  const gap = hint ? " ".repeat(Math.max(2, width - indent.length - visibleLength(label) - visibleLength(hint))) : "";

  if (active) {
    const text = `● ${label}${gap}${hint}`;
    return `${bg(ctx.theme.selectedBg)}${fg(ctx.theme.muted)}${bold()}${padRight(text, width)}${reset()}`;
  }
  const labelPart = `${fg(ctx.theme.text)}${label}${reset()}`;
  const hintPart = hint ? `${fg(ctx.theme.subtle)}${gap}${hint}${reset()}` : "";
  return padRight(`${indent}${labelPart}${hintPart}`, width);
}

function spread(left: string, right: string, width: number): string {
  const gap = Math.max(1, width - visibleLength(left) - visibleLength(right));
  return padRight(`${left}${" ".repeat(gap)}${right}`, width);
}

export function modalListLayout(opts: { search?: boolean; sectionLabel?: boolean; footer?: boolean }, height: number): { listStart: number; listHeight: number } {
  let listStart = 2;
  if (opts.search) listStart += 2;
  if (opts.sectionLabel) listStart += 1;
  const footerReserve = opts.footer ? 2 : 0;
  return { listStart, listHeight: Math.max(1, height - listStart - footerReserve) };
}

export function modalRowAt(rows: ModalRow[], selected: number, height: number, y: number, opts: { search?: boolean; sectionLabel?: boolean; footer?: boolean }): number | undefined {
  const { listStart, listHeight } = modalListLayout(opts, height);
  const local = y - 1 - listStart;
  if (local < 0 || local >= listHeight) return undefined;
  const start = scrollStart(selected, listHeight, rows.length);
  const index = start + local;
  return index < rows.length ? index : undefined;
}

function scrollStart(selected: number, listHeight: number, total: number): number {
  if (total <= listHeight) return 0;
  const start = selected - Math.floor(listHeight / 2);
  return Math.max(0, Math.min(start, total - listHeight));
}
