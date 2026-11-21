import type { ImageRenderProtocol } from "@opentui/core";

/**
 * How transcript images draw. The pixel protocols are OpenTUI's (`<image>`):
 * `auto` follows the terminal probe (kitty graphics, sixel, else half-block
 * cells; always blocks under tmux), and `none` draws no pixels, only the caption.
 */
export type ImageMode = ImageRenderProtocol | "none";

/** Environment override, shared with the legacy UI. */
export const IMAGE_PROTOCOL_ENV = "CREWCODER_TUI_IMAGE_PROTOCOL";

const MODES: Readonly<Record<string, ImageMode>> = {
  auto: "auto",
  kitty: "kitty",
  sixel: "sixel",
  blocks: "blocks",
  none: "none",
  off: "none"
};

/**
 * The image mode for this process. Unknown values (including legacy's `iterm`,
 * which OpenTUI does not speak) fall back to `auto`; iTerm2 then gets sixel when
 * it reports it. Remote sessions draw no pixels: a tool image path names a file
 * on the SSH host, and reading the same path here could show a different file.
 */
export function resolveImageMode(env: NodeJS.ProcessEnv, remote: boolean): ImageMode {
  if (remote) return "none";
  return MODES[(env[IMAGE_PROTOCOL_ENV] ?? "").trim().toLowerCase()] ?? "auto";
}

export type ImageBox = { cols: number; rows: number };

/** Same caps as legacy: at most 80 columns, and 35% of the screen between 4 and 18 rows. */
export const MAX_IMAGE_COLS = 80;
export const MIN_IMAGE_ROWS = 4;
export const MAX_IMAGE_ROWS = 18;

/**
 * The cell box an image gets in the transcript: the largest box inside the
 * caps that keeps the image's shape, assuming cells twice as tall as wide.
 * OpenTUI fits the pixels inside with the terminal's real cell shape, so a
 * different cell ratio only adds a small margin. Unknown dimensions take the
 * whole cap.
 */
export function imageBox(pixelWidth: number | undefined, pixelHeight: number | undefined, availableCols: number, screenRows: number): ImageBox {
  const maxCols = Math.max(1, Math.min(MAX_IMAGE_COLS, availableCols));
  const maxRows = Math.max(1, Math.min(MAX_IMAGE_ROWS, Math.max(MIN_IMAGE_ROWS, Math.floor(screenRows * 0.35))));
  if (!pixelWidth || !pixelHeight) return { cols: maxCols, rows: maxRows };
  // Columns per row that keep the shape: width/height in pixels, times 2 for the cell shape.
  const ratio = (pixelWidth / pixelHeight) * 2;
  let cols = maxCols;
  let rows = Math.round(cols / ratio);
  if (rows > maxRows) {
    rows = maxRows;
    cols = Math.round(rows * ratio);
  }
  return { cols: clamp(cols, maxCols), rows: clamp(rows, maxRows) };
}

function clamp(value: number, max: number): number {
  return Math.max(1, Math.min(max, value));
}
