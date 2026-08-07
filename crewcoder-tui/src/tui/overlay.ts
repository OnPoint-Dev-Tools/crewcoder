import type { Component, KeyEvent, RenderContext, RenderedImagePlacement } from "./component.js";
import { box, emptyLine, padRight } from "./layout.js";
import { bg, reset, stripAnsi } from "./ansi.js";

export type OverlayOptions = { width?: number; height?: number; title?: string };

/** A 1-based terminal rectangle, matching `RenderedImagePlacement` coordinates. */
export type ScreenRect = { top: number; left: number; width: number; height: number };

/**
 * Drops image placements that overlap a rectangle a modal is about to occupy.
 *
 * Terminal graphics sit above the text cells and cannot be clipped, so an image
 * behind a modal bleeds straight through the box. There is no partial answer:
 * an overlapping image is removed for this frame and redrawn once the modal
 * closes and the placement signature changes back.
 */
export function suppressImagesUnder(images: RenderedImagePlacement[] | undefined, rect: ScreenRect): void {
  if (!images?.length) return;
  const bottom = rect.top + rect.height - 1;
  const right = rect.left + rect.width - 1;
  for (let index = images.length - 1; index >= 0; index--) {
    const image = images[index]!;
    const overlapsRows = image.row <= bottom && image.row + image.placement.rows - 1 >= rect.top;
    const overlapsCols = image.col <= right && image.col + image.placement.cols - 1 >= rect.left;
    if (overlapsRows && overlapsCols) images.splice(index, 1);
  }
}

export class OverlayManager implements Component {
  private stack: Array<{ component: Component; options: OverlayOptions }> = [];
  constructor(private readonly base: Component) {}

  push(component: Component, options: OverlayOptions = {}): void { this.stack.push({ component, options }); }
  pop(): void { this.stack.pop(); }
  clear(): void { this.stack = []; }
  get hasOverlay(): boolean { return this.stack.length > 0; }

  render(ctx: RenderContext): string[] {
    const baseLines = this.base.render(ctx);
    if (!this.stack.length) return baseLines;
    const active = this.stack[this.stack.length - 1]!;
    const overlayWidth = Math.min(active.options.width ?? Math.floor(ctx.size.width * 0.65), ctx.size.width - 4);
    const overlayHeight = Math.min(active.options.height ?? Math.floor(ctx.size.height * 0.55), ctx.size.height - 4);
    const rendered = active.component.render({ ...ctx, size: { width: overlayWidth - 2, height: overlayHeight - 2 } });
    const inner = rendered.slice(0, overlayHeight - 2);
    while (inner.length < overlayHeight - 2) inner.push(emptyLine(overlayWidth - 2));
    const panel = box(inner, overlayWidth, ctx.theme.border);
    const top = Math.max(0, Math.floor((ctx.size.height - panel.length) / 2));
    const left = Math.max(0, Math.floor((ctx.size.width - overlayWidth) / 2));
    suppressImagesUnder(ctx.imagePlacements, { top: top + 1, left: left + 1, width: overlayWidth, height: panel.length });
    const result = [...baseLines];
    for (let i = 0; i < panel.length; i++) {
      const row = top + i;
      if (row >= result.length) break;
      const current = stripToWidth(result[row] ?? "", ctx.size.width);
      result[row] = current.slice(0, left) + paintBackground(panel[i]!, ctx.theme.panel) + current.slice(left + overlayWidth);
      result[row] = padRight(result[row]!, ctx.size.width);
    }
    return result;
  }

  handleInput(event: KeyEvent): void | boolean {
    if (this.stack.length) {
      if (event.name === "escape") { this.pop(); return true; }
      return this.stack[this.stack.length - 1]!.component.handleInput?.(event);
    }
    return this.base.handleInput?.(event);
  }
}

function stripToWidth(line: string, width: number): string {
  const plain = stripAnsi(line);
  return plain.length >= width ? plain.slice(0, width) : plain + " ".repeat(width - plain.length);
}

function paintBackground(line: string, fill: string): string {
  return `${bg(fill)}${line.replaceAll(reset(), `${reset()}${bg(fill)}`)}${reset()}`;
}
