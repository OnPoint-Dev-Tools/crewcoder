import type { Component, KeyEvent, RenderContext } from "../tui/component.js";
import { bg, bold, fg, reset } from "../tui/ansi.js";
import { emptyLine, padRight, wrapText } from "../tui/layout.js";

export type CompactionPreviewParams = {
  title: string;
  summary: string;
  source?: string;
  originalMessageCount?: number;
  retainedMessageCount?: number;
};

export type CompactionPreviewResult = { approved: boolean; summary: string };

type VisualRow = { text: string; start: number };

const MAX_EDITOR_ROWS = 12;

/**
 * Focused, in-TUI multi-line editor for a proposed compaction summary. The user
 * edits the text and applies it (`ctrl+s`) or cancels (`esc`, handled by App).
 * `onResolve` receives the final text plus whether it was approved; the caller
 * installs it over the live control channel or the `--summary-file` CLI path.
 */
export class CompactionPreviewOverlay implements Component {
  private text: string;
  private cursor: number;
  private readonly original: string;

  constructor(
    private readonly params: CompactionPreviewParams,
    private readonly onResolve: (result: CompactionPreviewResult) => void
  ) {
    this.text = params.summary;
    this.original = params.summary;
    this.cursor = params.summary.length;
  }

  desiredHeight(): number {
    return MAX_EDITOR_ROWS + 6;
  }

  render(ctx: RenderContext): string[] {
    const width = ctx.size.width;
    const lines: string[] = [];
    lines.push(spread(`${fg(ctx.theme.accent)}${bold()}${this.params.title}${reset()}`, `${fg(ctx.theme.muted)}esc cancel${reset()}`, width));
    lines.push(padRight(`${fg(ctx.theme.muted)}${this.metaLine()}${reset()}`, width));
    lines.push(emptyLine(width));

    const rows = this.visualRows(Math.max(1, width - 1));
    const window = this.windowAroundCursor(rows, MAX_EDITOR_ROWS);
    let cursorPlaced = false;
    for (const row of window) {
      lines.push(padRight(this.renderRow(row, ctx, () => (cursorPlaced = true)), width));
    }
    // The cursor may sit on the virtual position just past the last char.
    if (!cursorPlaced && window.length) {
      const last = lines.length - 1;
      lines[last] = padRight(`${lines[last] ?? ""}${this.cursorBar(ctx)}`, width);
    }

    while (lines.length < ctx.size.height - 2) lines.push(emptyLine(width));
    lines.push(emptyLine(width));
    lines.push(padRight(`${fg(ctx.theme.muted)}type to edit   ↵ newline   ^S apply   ^R reset   esc cancel${reset()}`, width));
    return lines.slice(0, ctx.size.height);
  }

  handleInput(event: KeyEvent): boolean {
    if (event.ctrl && event.name === "s") { this.onResolve({ approved: true, summary: this.text }); return true; }
    if (event.ctrl && event.name === "r") { this.text = this.original; this.cursor = this.text.length; return true; }
    if (event.name === "return") { this.insert("\n"); return true; }
    if (event.name === "backspace") { this.deleteBackward(); return true; }
    if (event.name === "delete") { this.deleteForward(); return true; }
    if (event.name === "left") { this.cursor = Math.max(0, this.cursor - 1); return true; }
    if (event.name === "right") { this.cursor = Math.min(this.text.length, this.cursor + 1); return true; }
    if (event.name === "up") { this.moveVertical("up"); return true; }
    if (event.name === "down") { this.moveVertical("down"); return true; }
    if (event.name === "home") { this.cursor = this.lineStart(this.cursor); return true; }
    if (event.name === "end") { this.cursor = this.lineEnd(this.cursor); return true; }
    if (event.sequence && event.sequence.length === 1 && !event.ctrl && !event.meta) { this.insert(event.sequence); return true; }
    return true;
  }

  private metaLine(): string {
    const parts: string[] = [];
    if (this.params.source) parts.push(`${this.params.source} summary`);
    if (typeof this.params.originalMessageCount === "number" && typeof this.params.retainedMessageCount === "number") {
      parts.push(`${this.params.originalMessageCount} → ${this.params.retainedMessageCount + 1} messages`);
    }
    return parts.join("  ·  ") || "proposed compaction summary";
  }

  private insert(fragment: string): void {
    this.text = this.text.slice(0, this.cursor) + fragment + this.text.slice(this.cursor);
    this.cursor += fragment.length;
  }

  private deleteBackward(): void {
    if (this.cursor <= 0) return;
    this.text = this.text.slice(0, this.cursor - 1) + this.text.slice(this.cursor);
    this.cursor -= 1;
  }

  private deleteForward(): void {
    if (this.cursor >= this.text.length) return;
    this.text = this.text.slice(0, this.cursor) + this.text.slice(this.cursor + 1);
  }

  private moveVertical(direction: "up" | "down"): void {
    const start = this.lineStart(this.cursor);
    const column = this.cursor - start;
    if (direction === "up") {
      if (start === 0) { this.cursor = 0; return; }
      const prevStart = this.lineStart(start - 1);
      const prevEnd = start - 1;
      this.cursor = Math.min(prevStart + column, prevEnd);
    } else {
      const end = this.lineEnd(this.cursor);
      if (end >= this.text.length) { this.cursor = this.text.length; return; }
      const nextStart = end + 1;
      const nextEnd = this.lineEnd(nextStart);
      this.cursor = Math.min(nextStart + column, nextEnd);
    }
  }

  private lineStart(index: number): number {
    return this.text.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
  }

  private lineEnd(index: number): number {
    const next = this.text.indexOf("\n", index);
    return next === -1 ? this.text.length : next;
  }

  private visualRows(width: number): VisualRow[] {
    const rows: VisualRow[] = [];
    let base = 0;
    for (const logical of this.text.split("\n")) {
      if (logical.length === 0) {
        rows.push({ text: "", start: base });
      } else {
        const wrapped = wrapText(logical, width);
        let offset = 0;
        for (const piece of wrapped.length ? wrapped : [""]) {
          const at = logical.indexOf(piece, offset);
          const pieceStart = at >= 0 ? at : offset;
          rows.push({ text: piece, start: base + pieceStart });
          offset = pieceStart + piece.length;
        }
      }
      base += logical.length + 1;
    }
    return rows;
  }

  private windowAroundCursor(rows: VisualRow[], maxRows: number): VisualRow[] {
    if (rows.length <= maxRows) return rows;
    let index = rows.findIndex((row) => this.cursor >= row.start && this.cursor <= row.start + row.text.length);
    if (index === -1) index = rows.length - 1;
    let start = Math.max(0, index - maxRows + 1);
    start = Math.min(start, rows.length - maxRows);
    return rows.slice(start, start + maxRows);
  }

  private renderRow(row: VisualRow, ctx: RenderContext, markPlaced: () => void): string {
    let rendered = "";
    for (let offset = 0; offset <= row.text.length; offset++) {
      const absolute = row.start + offset;
      if (absolute === this.cursor) { rendered += this.cursorBar(ctx); markPlaced(); }
      if (offset === row.text.length) break;
      rendered += `${fg(ctx.theme.text)}${row.text[offset]}${reset()}`;
    }
    return rendered;
  }

  private cursorBar(ctx: RenderContext): string {
    return `${bg(ctx.theme.accent)} ${reset()}`;
  }
}

function spread(left: string, right: string, width: number): string {
  const plainLeft = stripAnsiLite(left);
  const plainRight = stripAnsiLite(right);
  const gap = Math.max(1, width - plainLeft.length - plainRight.length);
  return padRight(`${left}${" ".repeat(gap)}${right}`, width);
}

function stripAnsiLite(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}
