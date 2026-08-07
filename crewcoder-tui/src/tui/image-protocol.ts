// Terminal inline-image support. We render real pixels through the Kitty graphics
// protocol (kitty, Ghostty) or the iTerm2 inline-image protocol when the terminal
// advertises support, and fall back to a metadata chip everywhere else. These
// encoders are pure string builders so they can be unit-tested without a TTY.

export type ImageProtocol = "kitty" | "iterm" | "none";

export type ImagePlacement = { cols: number; rows: number };

const OVERRIDE_VALUES: Record<string, ImageProtocol | "auto"> = {
  kitty: "kitty",
  iterm: "iterm",
  iterm2: "iterm",
  none: "none",
  off: "none",
  auto: "auto"
};

/**
 * Decide which inline-image protocol the active terminal supports. Honors an
 * explicit CREWCODER_TUI_IMAGE_PROTOCOL override (kitty|iterm|none|auto) so users
 * on unusual terminals can force or disable rendering.
 */
export function detectImageProtocol(env: NodeJS.ProcessEnv = process.env): ImageProtocol {
  const override = OVERRIDE_VALUES[(env.CREWCODER_TUI_IMAGE_PROTOCOL ?? "").trim().toLowerCase()];
  if (override && override !== "auto") return override;

  const term = (env.TERM ?? "").toLowerCase();
  const termProgram = (env.TERM_PROGRAM ?? "").toLowerCase();

  if (env.KITTY_WINDOW_ID || term.includes("kitty") || termProgram === "ghostty" || env.GHOSTTY_RESOURCES_DIR) return "kitty";
  if (termProgram === "iterm.app" || (env.LC_TERMINAL ?? "").toLowerCase() === "iterm2") return "iterm";
  return "none";
}

/**
 * Kitty graphics escape that transmits-and-displays a PNG by file path, sized to a
 * fixed cell box (c=cols, r=rows) so it occupies a predictable area the line
 * renderer can reserve. The path is base64-encoded per the protocol spec.
 */
export function encodeKittyImage(filePath: string, placement: ImagePlacement, imageId?: string): string {
  const payload = Buffer.from(filePath, "utf8").toString("base64");
  const id = imageId ? `,i=${kittyImageId(imageId)}` : "";
  const keys = `a=T,f=100,t=f,C=1${id},c=${Math.max(1, placement.cols)},r=${Math.max(1, placement.rows)}`;
  return `\x1b_G${keys};${payload}\x1b\\`;
}

/**
 * iTerm2 inline-image escape. Unlike Kitty this carries the base64 image bytes
 * directly and sizes in terminal cells.
 */
export function encodeItermImage(base64Data: string, placement: ImagePlacement): string {
  const args = `inline=1;preserveAspectRatio=1;width=${Math.max(1, placement.cols)};height=${Math.max(1, placement.rows)}`;
  return `\x1b]1337;File=${args}:${base64Data}\x07`;
}

/** Delete one Kitty/Ghostty graphics placement by its stable protocol id. */
export function encodeKittyDeleteImage(imageId: string): string {
  return `\x1b_Ga=d,d=i,i=${kittyImageId(imageId)}\x1b\\`;
}

/** Delete visible Kitty/Ghostty graphics placements before repainting a frame. */
export function encodeKittyDeleteVisibleImages(): string {
  return "\x1b_Ga=d,d=V\x1b\\";
}

export function kittyImageId(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) || 1;
}

/**
 * Fit an image's pixel dimensions into a cell box, preserving aspect ratio. Uses a
 * ~2:1 cell aspect (cells are about twice as tall as wide) so previews are not
 * vertically stretched. Falls back to the max box when pixel dimensions are unknown.
 */
export function fitPlacement(
  pixelWidth: number | undefined,
  pixelHeight: number | undefined,
  maxCols: number,
  maxRows: number
): ImagePlacement {
  const cols = Math.max(1, maxCols);
  const rows = Math.max(1, maxRows);
  if (!pixelWidth || !pixelHeight) return { cols, rows };

  const cellWidthToHeight = 0.5;
  const imageRatio = pixelWidth / pixelHeight / cellWidthToHeight;
  let fitCols = cols;
  let fitRows = Math.round(fitCols / imageRatio);
  if (fitRows > rows) {
    fitRows = rows;
    fitCols = Math.round(fitRows * imageRatio);
  }
  return { cols: Math.max(1, Math.min(cols, fitCols)), rows: Math.max(1, Math.min(rows, fitRows)) };
}
