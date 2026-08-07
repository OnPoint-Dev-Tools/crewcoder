/**
 * Live UI virtual frame compositor (SLICE 1).
 *
 * The sandboxed child only ever emits an array of plain text lines. The TUI owns
 * everything about how that text becomes pixels: clipping to the assigned box,
 * layout (border + title), colors (children may not paint their own ANSI), and
 * repaint scheduling. This is the "virtual frame protocol": the child proposes
 * text, the host disposes of it inside a bounded, host-styled surface.
 *
 * Three bounds are enforced here, independent of the protocol-level
 * `clampLiveUiLines` budget applied on the wire:
 *   - max width  -> each line is truncated to the inner box width
 *   - max height -> the frame is clipped to the assigned row budget
 *   - max output bytes -> the fully composited frame is capped so a wide/tall
 *     surface can never emit an unbounded terminal write
 */

import { stripAnsi } from "../tui/ansi.js";
import { box, padRight, truncate } from "../tui/layout.js";
import type { LiveUiFrame } from "./live-ui-protocol.js";

export type LiveUiFrameTheme = {
  border: string;
  focusBorder: string;
  title: string;
  text: string;
};

export type LiveUiFrameStyle = {
  /** Total frame width, including the box borders. */
  width: number;
  /** Total frame height, including the box borders and the title row. */
  height: number;
  focused: boolean;
  title: string;
  theme: LiveUiFrameTheme;
  /** Hard cap on the serialized byte size of the whole composited frame. */
  maxOutputBytes?: number;
  /**
   * When false, render only the sanitized content lines without the host box,
   * title row, or borders. Used for surface: "status" so the child can paint
   * directly into the status bar chrome.
   */
  boxed?: boolean;
  /**
   * Vertical scroll offset into the child's content. The host box chrome stays
   * fixed while the content lines are sliced starting at this offset.
   */
  scrollOffset?: number;
};

export const DEFAULT_LIVE_UI_FRAME_MAX_BYTES = 64 * 1024;

// Control characters (C0 range + DEL) the child must not be able to emit into a
// composited frame: they can move the cursor, clear the screen, or wedge the
// terminal. Tabs are handled separately so columns stay predictable.
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

/**
 * Remove any child-provided ANSI and control characters. Children propose text
 * only; the host paints the colors. Stripping cursor/clear escapes also prevents
 * a live component from scribbling outside its box or wedging the terminal.
 */
export function sanitizeLiveUiLine(line: string): string {
  return stripAnsi(line).replace(CONTROL_CHARS, " ").replace(/\t/g, "  ");
}

function clampContent(lines: readonly string[], innerWidth: number, contentRows: number): string[] {
  const rows: string[] = [];
  for (const raw of lines.slice(0, Math.max(0, contentRows))) {
    rows.push(padRight(truncate(sanitizeLiveUiLine(raw), innerWidth), innerWidth));
  }
  while (rows.length < Math.max(0, contentRows)) rows.push(padRight("", innerWidth));
  return rows;
}

/**
 * Flatten a structured virtual frame into plain text rows. Each row's cells are
 * concatenated; the cell text is already ANSI-free per the protocol, but it is
 * sanitized again here as defense in depth before the host paints its own style.
 */
export function flattenLiveUiFrame(frame: LiveUiFrame): string[] {
  return frame.lines.map((row) => row.map((cell) => cell.text).join(""));
}

/**
 * Composite a structured virtual frame into a bounded, host-styled box.
 */
export function compositeLiveUiFrame(frame: LiveUiFrame, style: LiveUiFrameStyle): string[] {
  return compositeLiveUiLines(flattenLiveUiFrame(frame), style);
}

/**
 * Composite plain text rows into a bounded, host-styled box. Returns the finished
 * frame lines ready to be blitted into a surface. Enforces the byte budget by
 * dropping trailing content rows (and, in the extreme, collapsing to a marker).
 */
export function compositeLiveUiLines(lines: readonly string[], style: LiveUiFrameStyle): string[] {
  const maxBytes = style.maxOutputBytes ?? DEFAULT_LIVE_UI_FRAME_MAX_BYTES;
  const scrollOffset = Math.max(0, Math.floor(style.scrollOffset ?? 0));

  if (style.boxed === false) {
    const width = Math.max(1, Math.floor(style.width));
    const height = Math.max(1, Math.floor(style.height));
    let content = clampContent(lines.slice(scrollOffset), width, height);
    while (frameByteLength(content) > maxBytes && content.length > 0) {
      content = content.slice(0, -1);
    }
    if (frameByteLength(content) > maxBytes) {
      return [padRight(truncate("frame exceeds byte budget", width), width)];
    }
    return content.map((line) => padRight(line, width));
  }

  const width = Math.max(4, Math.floor(style.width));
  const height = Math.max(3, Math.floor(style.height));
  const innerWidth = width - 2;
  const borderColor = style.focused ? style.theme.focusBorder : style.theme.border;

  const titleText = style.focused ? `● ${style.title}` : style.title;
  const titleRow = padRight(truncate(sanitizeLiveUiLine(titleText), innerWidth), innerWidth);
  // box() adds the top and bottom border rows; the remaining rows are the title
  // plus the child content.
  const contentRows = height - 2 - 1;

  let content = clampContent(lines.slice(scrollOffset), innerWidth, contentRows);
  let frame = box([titleRow, ...content], width, borderColor);
  while (frameByteLength(frame) > maxBytes && content.length > 0) {
    content = content.slice(0, -1);
    frame = box([titleRow, ...content], width, borderColor);
  }
  if (frameByteLength(frame) > maxBytes) {
    return box([truncate("frame exceeds byte budget", innerWidth)], width, borderColor);
  }
  return frame;
}

function frameByteLength(frame: readonly string[]): number {
  let bytes = 0;
  for (const line of frame) bytes += Buffer.byteLength(line, "utf8") + 1;
  return bytes;
}

/**
 * Coalesces repaint requests into a single scheduled repaint. Live children may
 * emit `request_repaint` host commands or fresh `rendered` frames in bursts; the
 * TUI, not the child, decides when a real terminal repaint happens.
 */
export class LiveUiRepaintScheduler {
  private pending = false;
  private scheduled = false;
  private readonly repaint: () => void;
  private readonly schedule: (cb: () => void) => void;

  constructor(repaint: () => void, schedule: (cb: () => void) => void = (cb) => queueMicrotask(cb)) {
    this.repaint = repaint;
    this.schedule = schedule;
  }

  get hasPending(): boolean {
    return this.pending;
  }

  request(): void {
    this.pending = true;
    if (this.scheduled) return;
    this.scheduled = true;
    this.schedule(() => this.flush());
  }

  flush(): void {
    this.scheduled = false;
    if (!this.pending) return;
    this.pending = false;
    this.repaint();
  }
}
