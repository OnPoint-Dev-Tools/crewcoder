import type { Component, KeyEvent, RenderContext } from "../tui/component.js";
import type { TuiState } from "../state/tui-store.js";
import { bg, bold, fg, reset, visibleLength } from "../tui/ansi.js";
import { padRight, truncate } from "../tui/layout.js";
import { formatContextStatus } from "../state/usage.js";
import { readClipboard, readClipboardImage, writeClipboard } from "../tui/clipboard.js";
import { describeAttachment, persistImageBuffer, persistImageFile, sniffImage, type ImageAttachment } from "../state/image-attachment.js";
import { toolHasExpandableOutput } from "./MainViewport.js";

export type SubmitHandler = (value: string) => void;

const MIN_INPUT_LINES = 1;
const MAX_INPUT_LINES = 8;
const PROMPT_WIDTH = 2;
const COMPOSER_INSET = 2;
const INPUT_RAIL_WIDTH = 2;
type InputLine = { text: string; start: number; end: number };

type ComposerRow = InputLine & { promptWidth: number; visibleIndex: number };

export class Composer implements Component {
  private rows: ComposerRow[] = [];
  private selectionAnchor: number | undefined;
  private selectionFocus: number | undefined;
  private lastFirstWrapWidth = 40;
  private lastRestWrapWidth = 40;
  /** Position in this session's sent messages while recalling; undefined when not recalling. */
  private historyIndex: number | undefined;
  /** Composer text saved when recall started, restored by walking back past the newest message. */
  private historyDraft = "";
  /** Last text this component recalled, used to detect that the user has since edited it. */
  private historyRecalled: string | undefined;

  constructor(private readonly state: TuiState, private readonly onSubmit: SubmitHandler) {}

  height(width: number): number {
    const inputWidth = Math.max(8, width - COMPOSER_INSET * 2);
    const { promptWidth, firstPromptWidth } = this.promptGeometry(width);
    const lines = this.inputLines(inputWidth, undefined, undefined, promptWidth, undefined, firstPromptWidth).length;
    return lines + 6 + (this.state.attachments.length ? 1 : 0);
  }

  private promptGeometry(width: number): { promptWidth: number; firstPromptLabel: string; firstPromptWidth: number } {
    const compact = width < 24;
    const activeContext = this.state.worker ?? this.state.mode;
    const displayContext = activeContext.charAt(0).toUpperCase() + activeContext.slice(1);
    const maxContextWidth = Math.max(1, Math.min(24, width - 19));
    const firstPromptLabel = compact ? "» " : `${truncate(displayContext, maxContextWidth)} » `;
    const promptWidth = (compact ? 2 : 5) + INPUT_RAIL_WIDTH;
    return { promptWidth, firstPromptLabel, firstPromptWidth: COMPOSER_INSET + INPUT_RAIL_WIDTH + visibleLength(firstPromptLabel) };
  }

  render(ctx: RenderContext): string[] {
    this.clampCursor();
    const usage = formatContextStatus(this.state.usage);
    const hasExpandableTools = this.state.blocks.some((block) => block.type === "tool" && toolHasExpandableOutput(block, this.state.rendererHooks));
    const tools = hasExpandableTools ? (this.state.toolOutputExpanded ? "tools expanded" : "Ctrl+O expand tools") : "";
    const inputWidth = Math.max(8, ctx.size.width - COMPOSER_INSET * 2);
    // The first row shows the active worker or mode, which can be wider than
    // the continuation indent. Derive geometry from the label so wrapping,
    // rendering, and cursor/mouse mapping all agree on where text starts.
    const { promptWidth, firstPromptLabel, firstPromptWidth } = this.promptGeometry(ctx.size.width);
    const maxRows = Math.max(MIN_INPUT_LINES, Math.min(MAX_INPUT_LINES, ctx.size.height - 4));
    const inputLines = this.inputLines(inputWidth, ctx.theme.accent, ctx.theme.selectedBg, promptWidth, maxRows, firstPromptWidth);
    this.rows = inputLines.map((line, index) => ({ ...line.source, promptWidth: index === 0 ? firstPromptWidth : promptWidth, visibleIndex: index }));
    const renderedInput = inputLines.map((line, index) => {
      const innerPromptWidth = Math.max(0, promptWidth - COMPOSER_INSET - INPUT_RAIL_WIDTH);
      const rail = `${fg(ctx.theme.borderStrong)}│${reset()} `;
      const prompt = index === 0 ? `${fg(ctx.theme.accent)}${firstPromptLabel}${reset()}` : " ".repeat(innerPromptWidth);
      return fieldLine(`${rail}${prompt}${line.rendered}`, ctx.size.width, ctx.theme.backgroundAlt, COMPOSER_INSET);
    });
    const access = this.state.fullAccess ? "Full Access" : "Review";
    const mode = this.state.worker ? `worker:${this.state.worker}` : this.state.mode;
    const marker = `${fg(ctx.theme.accent)}◈${reset()}`;
    const left = ` ${fg(ctx.theme.glow)}●${reset()}${fg(ctx.theme.muted)} ${access}${reset()}  ${marker} ${fg(ctx.theme.muted)}${bold()}MODE:${reset()} ${fg(ctx.theme.success)}${mode}${reset()}  ${marker} ${fg(ctx.theme.muted)}${bold()}MODEL:${reset()} ${fg(ctx.theme.success)}${this.state.provider}/${this.state.model}${reset()}  ${marker} ${fg(ctx.theme.muted)}${bold()}EFFORT:${reset()} ${fg(ctx.theme.success)}${this.state.effort}${reset()}`;

    const chips = this.renderAttachmentChips(ctx);
    return [
      roundedRule(ctx.size.width, ctx.theme.border, "top", COMPOSER_INSET, ctx.theme.backgroundAlt),
      ...renderedInput,
      roundedRule(ctx.size.width, ctx.theme.border, "bottom", COMPOSER_INSET, ctx.theme.backgroundAlt),
      ...(chips ? [chips] : []),
      fieldLine("", ctx.size.width),
      roundedRule(ctx.size.width, ctx.theme.selectedBg, "top"),
      this.renderStatusLine(left, tools ? `${tools}  ${usage}` : usage, ctx)
    ];
  }

  /**
   * Composer help and context usage share one baseline. Usage stays pinned to
   * the right while help truncates first on narrow terminals.
   */
  private renderStatusLine(left: string, status: string, ctx: RenderContext): string {
    const text = truncate(status, ctx.size.width);
    const leftWidth = Math.max(0, ctx.size.width - text.length - 1);
    const renderedLeft = truncate(left, leftWidth);
    const pad = Math.max(0, ctx.size.width - strip(renderedLeft).length - text.length);
    const firstSpace = text.indexOf(" ");
    const icon = firstSpace >= 0 ? text.slice(0, firstSpace) : text;
    const rest = firstSpace >= 0 ? text.slice(firstSpace) : "";
    return `${renderedLeft}${" ".repeat(pad)}${fg(ctx.theme.accent)}${icon}${reset()}${fg(ctx.theme.subtle)}${rest}${reset()}`;
  }

  private renderAttachmentChips(ctx: RenderContext): string | undefined {
    if (!this.state.attachments.length) return undefined;
    const chips = this.state.attachments
      .map((attachment, index) => `${bg(ctx.theme.surfaceAlt)}${fg(ctx.theme.accent2)} IMG ${index + 1} ${fg(ctx.theme.muted)}${describeAttachment(attachment)} ${reset()}`)
      .join(" ");
    const hint = `${fg(ctx.theme.subtle)}ctrl+x clear${reset()}`;
    const bottomStatus = Math.max(1, ctx.size.width - strip(chips).length - strip(hint).length);
    return padRight(`${chips}${" ".repeat(bottomStatus)}${hint}`, ctx.size.width);
  }

  handleInput(event: KeyEvent): void | boolean {
    this.clampCursor();
    if (event.ctrl && event.name === "c") process.exit(0);
    if (event.ctrl && event.name === "x" && this.state.attachments.length) {
      // Clear pending image attachments before they are sent.
      this.state.attachments = [];
      return true;
    }
    if ((event.ctrl || event.meta) && event.name === "v") {
      // Prefer an image on the clipboard (screenshot paste); fall back to text.
      if (this.pasteImage()) return true;
      const text = readClipboard();
      if (text && this.attachImagePathsFromText(text)) return true;
      if (text) this.insert(text);
      return true;
    }
    if (event.name === "return") {
      // Shift+Enter (kitty/xterm protocols), Alt+Enter, and Ctrl+J all insert a newline.
      if (event.shift || event.meta) {
        this.insert("\n");
        return true;
      }
      const value = this.state.input.trim();
      this.attachImagePathsFromText(value);
      this.state.input = "";
      this.state.inputCursor = 0;
      this.clearSelection();
      this.resetHistoryRecall();
      // Submit when there is text OR at least one pending image attachment, so a
      // screenshot can be sent on its own.
      if (value || this.state.attachments.length) this.onSubmit(value);
      return true;
    }
    if (event.name === "left") { this.moveCursor(-1); return true; }
    if (event.name === "right") { this.moveCursor(1); return true; }
    if (event.name === "up" || event.name === "down") return this.handleVerticalArrow(event.name);
    if (event.name === "home") { this.state.inputCursor = event.ctrl ? 0 : this.currentLineStart(); this.clearSelection(); return true; }
    if (event.name === "end") { this.state.inputCursor = event.ctrl ? this.state.input.length : this.currentLineEnd(); this.clearSelection(); return true; }
    if (event.name === "delete") { this.deleteForward(); return true; }
    if (event.name === "backspace") { this.deleteBackward(); return true; }
    if (event.name === "escape") return true;
    if (event.sequence && event.sequence.length === 1 && !event.ctrl && !event.meta) { this.insert(event.sequence); return true; }
    return false;
  }

  handleMouse(event: KeyEvent, topRow: number, copy: (text: string) => boolean = writeClipboard, onCopied?: () => void): boolean {
    if (event.name !== "mouse" || !event.mouse) return false;
    const cursor = this.cursorFromMouse(event.mouse.x, event.mouse.y - topRow);
    if (cursor === undefined) return false;
    if (event.mouse.kind === "press") {
      this.selectionAnchor = cursor;
      this.selectionFocus = cursor;
      this.state.inputCursor = cursor;
      return true;
    }
    if (event.mouse.kind === "drag") {
      this.selectionFocus = cursor;
      this.state.inputCursor = cursor;
      return true;
    }
    if (event.mouse.kind === "release") {
      this.selectionFocus = cursor;
      this.state.inputCursor = cursor;
      const selected = this.selectedText();
      if (selected && copy(selected)) {
        this.clearSelection();
        onCopied?.();
      }
      return true;
    }
    return false;
  }

  private insert(text: string): void {
    this.replaceSelection(text);
  }

  /**
   * Read an image from the clipboard, persist it, and attach it to the pending
   * turn. Returns true when an image was attached so the caller skips text paste.
   */
  private pasteImage(): boolean {
    const clipboardImage = readClipboardImage();
    if (!clipboardImage) return false;
    const info = sniffImage(clipboardImage.data) ?? { mime: "image/png" as const };
    const attachment = persistImageBuffer(clipboardImage.data, info, "clipboard");
    this.state.attachments = [...this.state.attachments, attachment];
    return true;
  }

  private attachImagePathsFromText(text: string): boolean {
    const paths = imagePathsFromText(text);
    const existingPaths = new Set(this.state.attachments.map((attachment) => attachment.path));
    const attachments: ImageAttachment[] = [];
    for (const filePath of paths) {
      const attachment = persistImageFile(filePath);
      if (!attachment || existingPaths.has(attachment.path)) continue;
      attachments.push(attachment);
      existingPaths.add(attachment.path);
    }
    if (!attachments.length) return false;
    this.state.attachments = [...this.state.attachments, ...attachments];
    return true;
  }

  private replaceSelection(text: string): void {
    const range = this.selectionRange();
    if (range) {
      this.state.input = this.state.input.slice(0, range.start) + text + this.state.input.slice(range.end);
      this.state.inputCursor = range.start + text.length;
      this.clearSelection();
      return;
    }
    this.state.input = this.state.input.slice(0, this.state.inputCursor) + text + this.state.input.slice(this.state.inputCursor);
    this.state.inputCursor += text.length;
  }

  private deleteBackward(): void {
    const range = this.selectionRange();
    if (range) { this.replaceSelection(""); return; }
    if (this.state.inputCursor <= 0) return;
    this.state.input = this.state.input.slice(0, this.state.inputCursor - 1) + this.state.input.slice(this.state.inputCursor);
    this.state.inputCursor -= 1;
  }

  private deleteForward(): void {
    const range = this.selectionRange();
    if (range) { this.replaceSelection(""); return; }
    if (this.state.inputCursor >= this.state.input.length) return;
    this.state.input = this.state.input.slice(0, this.state.inputCursor) + this.state.input.slice(this.state.inputCursor + 1);
  }

  private moveCursor(delta: number): void {
    this.state.inputCursor = Math.max(0, Math.min(this.state.input.length, this.state.inputCursor + delta));
    this.clearSelection();
  }

  /**
   * Moves the cursor up/down across the wrapped input lines. At the first/last
   * line it recalls this session's sent messages instead. Returns false only
   * when neither applies, so the caller can fall back to other behavior (e.g.
   * scrolling the conversation viewport).
   */
  handleVerticalArrow(direction: "up" | "down"): boolean {
    this.clampCursor();
    if (this.moveVertical(direction)) return true;
    return this.recallHistory(direction);
  }

  /**
   * Recall over the messages already sent in this session: each Up loads the
   * next most recent one, Down walks back toward the saved draft. History is
   * derived from the transcript, so it is session-scoped for free and a resumed
   * session recalls its own messages.
   */
  private recallHistory(direction: "up" | "down"): boolean {
    // Typing after a recall abandons it, so the next Up starts from the newest.
    if (this.historyIndex !== undefined && this.state.input !== this.historyRecalled) this.resetHistoryRecall();
    const messages = this.sentMessages();
    if (!messages.length) return false;

    if (direction === "up") {
      const older = this.historyIndex === undefined ? 0 : this.historyIndex + 1;
      if (older >= messages.length) return false;
      if (this.historyIndex === undefined) this.historyDraft = this.state.input;
      this.historyIndex = older;
      return this.applyRecall(messages[older]!);
    }

    if (this.historyIndex === undefined) return false;
    const newer = this.historyIndex - 1;
    if (newer < 0) {
      const draft = this.historyDraft;
      this.resetHistoryRecall();
      return this.applyRecall(draft);
    }
    this.historyIndex = newer;
    return this.applyRecall(messages[newer]!);
  }

  /** This session's user messages, most recent first. */
  private sentMessages(): string[] {
    const messages: string[] = [];
    for (const block of this.state.blocks) {
      if (block.type !== "user") continue;
      const text = block.text.trim();
      // Skip blanks and repeats of the message right after this one, so every
      // Up press lands on visibly different text.
      if (text && text !== messages[0]) messages.unshift(text);
    }
    return messages;
  }

  private applyRecall(text: string): boolean {
    this.state.input = text;
    this.state.inputCursor = text.length;
    this.historyRecalled = text;
    this.clearSelection();
    return true;
  }

  private resetHistoryRecall(): void {
    this.historyIndex = undefined;
    this.historyDraft = "";
    this.historyRecalled = undefined;
  }

  private moveVertical(direction: "up" | "down"): boolean {
    const lines = wrapInput(this.state.input, this.lastFirstWrapWidth, this.lastRestWrapWidth);
    let index = lines.findIndex((line) => this.state.inputCursor >= line.start && this.state.inputCursor <= line.end);
    if (index === -1) index = lines.length - 1;
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    const target = lines[targetIndex];
    if (!target) return false;
    const column = this.state.inputCursor - lines[index]!.start;
    this.state.inputCursor = Math.min(target.start + column, target.end);
    this.clearSelection();
    return true;
  }

  private currentLineStart(): number {
    return this.state.input.lastIndexOf("\n", Math.max(0, this.state.inputCursor - 1)) + 1;
  }

  private currentLineEnd(): number {
    const next = this.state.input.indexOf("\n", this.state.inputCursor);
    return next === -1 ? this.state.input.length : next;
  }

  private cursorFromMouse(x: number, row: number): number | undefined {
    const target = this.rows[row - 1];
    if (!target) return undefined;
    const column = Math.max(0, x - 1 - target.promptWidth);
    return Math.max(target.start, Math.min(target.end, target.start + column));
  }

  private selectedText(): string {
    const range = this.selectionRange();
    return range ? this.state.input.slice(range.start, range.end) : "";
  }

  private selectionRange(): { start: number; end: number } | undefined {
    if (this.selectionAnchor === undefined || this.selectionFocus === undefined || this.selectionAnchor === this.selectionFocus) return undefined;
    return { start: Math.min(this.selectionAnchor, this.selectionFocus), end: Math.max(this.selectionAnchor, this.selectionFocus) };
  }

  private clearSelection(): void {
    this.selectionAnchor = undefined;
    this.selectionFocus = undefined;
  }

  private clampCursor(): void {
    this.state.inputCursor = Math.max(0, Math.min(this.state.input.length, this.state.inputCursor));
  }

  private inputLines(width: number, cursorColor = "#93e8d1", selectionBg = "#2f6f5a", promptWidth = PROMPT_WIDTH, maxRows = MAX_INPUT_LINES, firstPromptWidth = promptWidth): Array<{ rendered: string; source: InputLine }> {
    const restWidth = Math.max(1, width - promptWidth);
    const firstWidth = Math.max(1, width - firstPromptWidth);
    this.lastFirstWrapWidth = firstWidth;
    this.lastRestWrapWidth = restWidth;
    const lines = wrapInput(this.state.input, firstWidth, restWidth);
    const visible = windowAroundCursor(lines, this.state.inputCursor, Math.max(MIN_INPUT_LINES, maxRows));
    return visible.map((line) => ({ rendered: this.renderInputLine(line, cursorColor, selectionBg), source: line }));
  }

  private renderInputLine(line: InputLine, cursorColor: string, selectionBg: string): string {
    const range = this.selectionRange();
    let rendered = "";
    for (let offset = 0; offset <= line.text.length; offset++) {
      const absolute = line.start + offset;
      if (absolute === this.state.inputCursor) rendered += this.cursorBar(cursorColor);
      if (offset === line.text.length) break;
      const char = line.text[offset]!;
      const selected = range && absolute >= range.start && absolute < range.end;
      rendered += selected ? `${bg(selectionBg)}${char}${reset()}` : char;
    }
    return rendered;
  }

  private cursorBar(color: string): string {
    return `${bg(color)} ${reset()}`;
  }
}

function wrapInput(text: string, firstWidth: number, restWidth: number): InputLine[] {
  const safeFirst = Math.max(1, firstWidth);
  const safeRest = Math.max(1, restWidth);
  if (!text) return [{ text: "", start: 0, end: 0 }];
  const result: InputLine[] = [];
  let lineStart = 0;
  // The first visual row carries the active-context prompt, so it has less room
  // for text than the indented continuation rows. Pick the width per emitted row.
  const widthFor = (): number => (result.length === 0 ? safeFirst : safeRest);
  for (const raw of text.split("\n")) {
    wrapRawLine(raw, lineStart, widthFor, result);
    lineStart += raw.length + 1;
  }
  if (text.endsWith("\n")) result.push({ text: "", start: text.length, end: text.length });
  return result;
}

function wrapRawLine(raw: string, base: number, widthFor: () => number, result: InputLine[]): void {
  if (!raw) { result.push({ text: "", start: base, end: base }); return; }
  let offset = 0;
  for (let width = widthFor(); raw.length - offset > width; width = widthFor()) {
    const slice = raw.slice(offset, offset + width + 1);
    const breakAt = Math.max(slice.lastIndexOf(" "), slice.lastIndexOf("\t"));
    const cut = breakAt > Math.floor(width * 0.5) ? breakAt : width;
    let end = offset + cut;
    while (end > offset && /[ \t]/.test(raw[end - 1]!)) end -= 1;
    result.push({ text: raw.slice(offset, end), start: base + offset, end: base + end });
    offset += cut;
    while (/[ \t]/.test(raw[offset] ?? "")) offset += 1;
  }
  result.push({ text: raw.slice(offset), start: base + offset, end: base + raw.length });
}

function windowAroundCursor(lines: InputLine[], cursor: number, maxRows: number): InputLine[] {
  if (lines.length <= maxRows) return lines;
  let index = lines.findIndex((line) => cursor >= line.start && cursor <= line.end);
  if (index === -1) index = lines.length - 1;
  let start = Math.max(0, index - maxRows + 1);
  start = Math.min(start, lines.length - maxRows);
  return lines.slice(start, start + maxRows);
}

function fieldLine(content: string, width: number, fill?: string, inset = 0): string {
  const safeInset = Math.max(0, Math.min(inset, Math.floor(width / 2)));
  const horizontalPadding = " ".repeat(safeInset);
  const contentWidth = Math.max(0, width - safeInset * 2);
  if (!fill) return `${horizontalPadding}${padRight(content, contentWidth)}${horizontalPadding}`;
  const repainted = content.replaceAll(reset(), `${reset()}${bg(fill)}`);
  return `${horizontalPadding}${bg(fill)}${padRight(repainted, contentWidth)}${reset()}${horizontalPadding}`;
}

function roundedRule(width: number, color: string, edge: "top" | "bottom", inset = 0, fill?: string): string {
  const safeInset = Math.max(0, Math.min(inset, Math.floor(width / 2)));
  const horizontalPadding = " ".repeat(safeInset);
  const ruleWidth = Math.max(0, width - safeInset * 2);
  const glyph = fill ? edge === "top" ? "▔" : "▁" : "━";
  const background = fill ? bg(fill) : "";
  return `${horizontalPadding}${background}${fg(color)}${glyph.repeat(ruleWidth)}${reset()}${horizontalPadding}`;
}

function pill(label: string, value: string, color: string, fill: string): string {
  return `${bg(fill)}${fg(color)} ${bold()}${label}${reset()}${bg(fill)}${fg(color)} ${value} ${reset()}`;
}

function imagePathsFromText(text: string): string[] {
  const values = new Set<string>();
  for (const match of text.matchAll(/(?:file:\/\/)?(?:~|\/|\.\.?\/)[^\s'"`<>]+\.(?:png|jpe?g|gif|webp|bmp)\b/gi)) {
    const raw = match[0] ?? "";
    const filePath = raw.startsWith("file://") ? decodeURIComponent(raw.slice("file://".length)) : raw;
    values.add(expandHome(filePath));
  }
  return [...values];
}

function expandHome(filePath: string): string {
  if (filePath === "~") return process.env.HOME ?? filePath;
  if (filePath.startsWith("~/")) return `${process.env.HOME ?? "~"}${filePath.slice(1)}`;
  return filePath;
}

function strip(value: string): string { return value.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""); }
