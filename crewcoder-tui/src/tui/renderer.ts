import fs from "node:fs";
import { bg, clearScreen, clearScrollback, cursorToColumn, cursorUp, disableAutowrap, disableBracketedPaste, disableFocusReporting, disableKeyboardProtocol, disableMouse, enableAutowrap, enableBracketedPaste, enableFocusReporting, enableKeyboardProtocol, enableMouse, eraseDown, hideCursor, moveTo, reset, resetTerminalBackground, setTerminalBackground, showCursor } from "./ansi.js";
import type { Component, RenderContext, RenderedImagePlacement, Size, TerminalFrame } from "./component.js";
import { encodeItermImage, encodeKittyDeleteImage, encodeKittyDeleteVisibleImages, encodeKittyImage } from "./image-protocol.js";
import { padRight } from "./layout.js";
import type { CrewCoderTheme } from "../theme/theme.js";

const IMAGE_REDRAW_DEBOUNCE_MS = 100;

export class Renderer {
  private previousLines: string[] = [];
  private previousImagePlacements: RenderedImagePlacement[] = [];
  private previousImageSignature = "";
  private drawnImageSignature = "";
  private imageRedrawTimer: NodeJS.Timeout | undefined;
  private running = false;
  private hasKittyImages = false;
  private mouseEnabled = false;
  private autowrapDisabled = false;
  private writeMode: "screen" | "scrollback" = "screen";
  private previousSettled: string[] = [];
  private previousLive: string[] = [];
  private liveHeight = 0;

  constructor(
    private readonly root: Component,
    private readonly theme: CrewCoderTheme,
    private readonly out: NodeJS.WriteStream = process.stdout
  ) {}

  start(): void {
    this.running = true;
    this.out.write(setTerminalBackground(this.theme.background) + hideCursor() + enableFocusReporting() + enableBracketedPaste() + enableKeyboardProtocol());
    this.render(true);
  }

  stop(): void {
    this.running = false;
    this.cancelImageRedraw();
    this.deleteKittyImages(this.previousImagePlacements);
    this.hasKittyImages = false;
    this.previousImagePlacements = [];
    this.previousImageSignature = "";
    this.drawnImageSignature = "";
    this.setMouseEnabled(false);
    this.setAutowrap(true);
    this.out.write(disableKeyboardProtocol() + disableBracketedPaste() + disableFocusReporting() + showCursor() + reset() + resetTerminalBackground() + "\n");
  }

  render(force = false): void {
    if (!this.running && !force) return;
    const size = getTerminalSize();
    const imagePlacements: RenderedImagePlacement[] = [];
    const ctx: RenderContext = { theme: this.theme, size, imagePlacements };
    const frame = this.root.frame?.(ctx) ?? { mode: "screen" as const, lines: this.root.render(ctx) };
    if (frame.mode === "scrollback") {
      this.renderScrollback(frame, size, force);
      return;
    }
    this.enterScreenMode(force);
    const nextLines = normalizeHeight(frame.lines, size.height, size.width, this.theme.background);
    const imageSignature = imagePlacementSignature(imagePlacements);

    if (force || this.previousLines.length === 0) {
      this.cancelImageRedraw();
      this.deleteKittyImages(this.previousImagePlacements);
      this.out.write(clearScreen());
      this.writeFullFrame(nextLines);
      this.drawImages(imagePlacements);
      this.previousLines = nextLines;
      this.previousImagePlacements = imagePlacements;
      this.previousImageSignature = imageSignature;
      this.drawnImageSignature = imageSignature;
      return;
    }

    // A resize changes the line count and invalidates row-by-row comparison, so the
    // changed-row set is only meaningful when both frames have the same height.
    const changedRows = nextLines.length === this.previousLines.length ? changedRowNumbers(nextLines, this.previousLines) : undefined;
    const imagesChanged = imageSignature !== this.previousImageSignature;
    if (changedRows?.size === 0 && !imagesChanged) return;

    const imageRows = rowsCoveredByImages([...this.previousImagePlacements, ...imagePlacements], nextLines.length);
    // Graphics only need erasing when a placement moved or when repainted text would
    // overwrite the pixels. Without this, an unrelated change elsewhere on screen (the
    // 90ms spinner against the 120ms render tick) deleted every image and re-drew it a
    // debounce later, which reads as flicker.
    const textOverwritesImages = !changedRows || setsIntersect(changedRows, imageRows);
    if (changedRows && !imagesChanged && !textOverwritesImages) {
      for (const row of changedRows) {
        this.out.write(moveTo(row, 1));
        this.out.write(nextLines[row - 1]!);
      }
      this.previousLines = nextLines;
      this.previousImagePlacements = imagePlacements;
      // Nothing was erased, so an already-painted image stays painted. Only re-arm the
      // pass when a previous diff frame left the images undrawn with no redraw pending.
      if (imagePlacements.length && this.drawnImageSignature !== imageSignature && !this.imageRedrawTimer) {
        this.scheduleImageRedraw(imagePlacements, imageSignature);
      }
      return;
    }

    this.cancelImageRedraw();
    this.deleteKittyImages([...this.previousImagePlacements, ...imagePlacements]);
    for (let i = 0; i < nextLines.length; i++) {
      if (nextLines[i] !== this.previousLines[i] || imageRows.has(i + 1)) {
        this.out.write(moveTo(i + 1, 1));
        this.out.write(nextLines[i]);
      }
    }
    this.previousLines = nextLines;
    this.previousImagePlacements = imagePlacements;
    this.previousImageSignature = imageSignature;
    this.drawnImageSignature = "";
    this.scheduleImageRedraw(imagePlacements, imageSignature);
  }

  private enterScreenMode(force: boolean): void {
    this.setMouseEnabled(shouldEnableMouseReporting());
    this.setAutowrap(true);
    if (this.writeMode === "scrollback") force = true;
    this.writeMode = "screen";
    this.previousLive = [];
    this.liveHeight = 0;
    if (force) this.previousLines = [];
  }

  private renderScrollback(frame: TerminalFrame, size: Size, force: boolean): void {
    const live = (frame.lines ?? []).map((line) => paintLineBackground(line, size.width, this.theme.background));
    // Keep settled rows in their raw form. Painting the full transcript on
    // every 120ms tick made a long, unchanged session expensive even though no
    // history was written. Only paint the newly committed suffix (or all rows
    // when history genuinely has to be rebuilt).
    const settled = frame.settled ?? [];
    const images = frame.images ?? [];
    const entering = this.writeMode !== "scrollback";
    this.writeMode = "scrollback";
    this.setMouseEnabled(false);
    this.setAutowrap(false);

    const prefix = settledPrefixLength(this.previousSettled, settled);
    const overlap = prefix < this.previousSettled.length
      ? settledSuffixPrefixLength(this.previousSettled, settled)
      : 0;
    // The reducer bounds in-memory blocks by dropping the oldest entries. A
    // substantial previous-suffix/next-prefix overlap identifies that rolling
    // window, so terminal history can remain intact. Small overlaps are not
    // trusted because transcript layouts contain many repeated blank rows.
    const minimumReliableOverlap = Math.min(16, this.previousSettled.length, settled.length);
    const rollingWindow = minimumReliableOverlap > 0 && overlap >= minimumReliableOverlap;
    const historyChanged = prefix < this.previousSettled.length && !rollingWindow;
    const rewriteHistory = force || historyChanged;
    const retained = rollingWindow ? overlap : prefix;
    const commit = (rewriteHistory ? settled : settled.slice(retained))
      .map((line) => paintLineBackground(line, size.width, this.theme.background));
    const liveUnchanged = !entering && !rewriteHistory && commit.length === 0 && liveEquals(live, this.previousLive);
    const imageSignature = imagePlacementSignature(images);
    if (liveUnchanged && imageSignature === this.previousImageSignature) return;

    this.cancelImageRedraw();
    this.deleteKittyImages([...this.previousImagePlacements, ...images]);

    if (rewriteHistory) {
      this.out.write(clearScrollback() + clearScreen());
      this.writeScrollbackLines(commit, true);
    } else if (entering) {
      // Full-screen surfaces use cursor addressing and do not alter committed
      // terminal history. Clear only their visible frame, then continue from
      // the settled prefix we had before opening the surface.
      this.out.write(clearScreen());
      this.writeScrollbackLines(commit, true);
    } else {
      this.eraseLive();
      this.writeScrollbackLines(commit, true);
    }
    this.writeScrollbackLines(live, false);

    const liveStartRow = Math.max(1, Math.min(settled.length + 1, size.height - live.length + 1));
    const placed = images.map((image) => ({ ...image, row: liveStartRow + image.row - 1 }));
    this.previousSettled = settled;
    this.previousLive = live;
    this.liveHeight = live.length;
    this.previousLines = [];
    this.previousImagePlacements = placed;
    this.previousImageSignature = imageSignature;
    this.drawnImageSignature = "";
    this.scheduleImageRedraw(placed, imageSignature);
  }

  private eraseLive(): void {
    if (this.liveHeight <= 0) return;
    this.out.write(cursorToColumn(1) + cursorUp(this.liveHeight - 1) + eraseDown());
  }

  private writeScrollbackLines(lines: string[], trailingNewline: boolean): void {
    if (!lines.length) return;
    for (let index = 0; index < lines.length; index++) {
      this.out.write(lines[index] ?? "");
      // DECAWM is disabled in scrollback mode so a width-sized row cannot
      // double-wrap. LF alone preserves the current column in VT terminals;
      // CRLF is required to start the next transcript row at column one.
      if (trailingNewline || index < lines.length - 1) this.out.write("\r\n");
    }
  }

  private setMouseEnabled(wanted: boolean): void {
    if (!shouldEnableMouseReporting()) wanted = false;
    if (wanted === this.mouseEnabled) return;
    this.mouseEnabled = wanted;
    this.out.write(wanted ? enableMouse() : disableMouse());
  }

  private setAutowrap(enabled: boolean): void {
    const disable = !enabled;
    if (disable === this.autowrapDisabled) return;
    this.autowrapDisabled = disable;
    this.out.write(disable ? disableAutowrap() : enableAutowrap());
  }

  private writeFullFrame(lines: string[]): void {
    for (let i = 0; i < lines.length; i++) {
      this.out.write(moveTo(i + 1, 1));
      this.out.write(lines[i] ?? "");
    }
  }

  private drawImages(images: RenderedImagePlacement[]): void {
    this.hasKittyImages = images.some((image) => image.protocol === "kitty");
    for (const image of images) {
      this.out.write(moveTo(image.row, image.col));
      if (image.protocol === "kitty") {
        this.out.write(encodeKittyImage(image.attachment.path, image.placement, image.id));
      } else {
        const bytes = readImageBytes(image.attachment.path);
        if (bytes) this.out.write(encodeItermImage(bytes.toString("base64"), image.placement));
      }
    }
  }

  private deleteKittyImages(images: RenderedImagePlacement[]): void {
    const ids = new Set(images.filter((image) => image.protocol === "kitty").map((image) => image.id));
    if (!ids.size && !this.hasKittyImages) return;
    for (const id of ids) this.out.write(encodeKittyDeleteImage(id));
    this.out.write(encodeKittyDeleteVisibleImages());
  }

  private scheduleImageRedraw(images: RenderedImagePlacement[], signature: string): void {
    if (!images.length) return;
    const scheduledImages = images.map((image) => ({ ...image }));
    this.imageRedrawTimer = setTimeout(() => {
      this.imageRedrawTimer = undefined;
      if (!this.running || signature !== this.previousImageSignature) return;
      this.drawImages(scheduledImages);
      this.drawnImageSignature = signature;
    }, IMAGE_REDRAW_DEBOUNCE_MS);
  }

  private cancelImageRedraw(): void {
    if (!this.imageRedrawTimer) return;
    clearTimeout(this.imageRedrawTimer);
    this.imageRedrawTimer = undefined;
  }
}

function readImageBytes(filePath: string): Buffer | undefined {
  try {
    return fs.readFileSync(filePath);
  } catch {
    return undefined;
  }
}

/** 1-based terminal rows whose text differs between two equal-height frames. */
function changedRowNumbers(nextLines: string[], previousLines: string[]): Set<number> {
  const rows = new Set<number>();
  for (let index = 0; index < nextLines.length; index++) {
    if (nextLines[index] !== previousLines[index]) rows.add(index + 1);
  }
  return rows;
}

function setsIntersect(left: Set<number>, right: Set<number>): boolean {
  for (const value of left) if (right.has(value)) return true;
  return false;
}

function imagePlacementSignature(images: RenderedImagePlacement[]): string {
  return images
    .map((image) => [image.id, image.protocol, image.row, image.col, image.placement.cols, image.placement.rows, image.attachment.path].join(":"))
    .join("|");
}

function rowsCoveredByImages(images: RenderedImagePlacement[], maxRows: number): Set<number> {
  const rows = new Set<number>();
  for (const image of images) {
    const start = Math.max(1, image.row);
    const end = Math.min(maxRows, image.row + image.placement.rows - 1);
    for (let row = start; row <= end; row++) rows.add(row);
  }
  return rows;
}

function shouldEnableMouseReporting(): boolean {
  return process.env.CREWCODER_TUI_MOUSE !== "0";
}

function getTerminalSize(): Size {
  return { width: process.stdout.columns || 100, height: process.stdout.rows || 32 };
}

function normalizeHeight(lines: string[], height: number, width: number, background: string): string[] {
  const result = lines.slice(0, height).map((line) => paintLineBackground(line, width, background));
  while (result.length < height) result.push(paintLineBackground("", width, background));
  return result;
}

function paintLineBackground(line: string, width: number, background: string): string {
  const repainted = padRight(line, width).replaceAll(reset(), `${reset()}${bg(background)}`);
  return `${bg(background)}${repainted}${reset()}`;
}

function settledPrefixLength(previous: string[], next: string[]): number {
  const limit = Math.min(previous.length, next.length);
  let index = 0;
  while (index < limit && previous[index] === next[index]) index += 1;
  return index;
}

function settledSuffixPrefixLength(previous: string[], next: string[]): number {
  if (!previous.length || !next.length) return 0;
  const separator = Symbol("settled-overlap");
  const values: Array<string | symbol> = [...next, separator, ...previous];
  const prefix = new Array<number>(values.length).fill(0);
  for (let index = 1; index < values.length; index++) {
    let candidate = prefix[index - 1] ?? 0;
    while (candidate > 0 && values[index] !== values[candidate]) candidate = prefix[candidate - 1] ?? 0;
    if (values[index] === values[candidate]) candidate += 1;
    prefix[index] = Math.min(candidate, next.length);
  }
  return prefix.at(-1) ?? 0;
}

function liveEquals(next: string[], previous: string[]): boolean {
  if (next.length !== previous.length) return false;
  for (let index = 0; index < next.length; index++) {
    if (next[index] !== previous[index]) return false;
  }
  return true;
}
