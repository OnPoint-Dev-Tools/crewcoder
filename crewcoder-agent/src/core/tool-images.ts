import fs from "node:fs/promises";
import path from "node:path";

/**
 * An image a tool produced or read, declared on `ToolResult.details.images` so the
 * TUI can blit it inline instead of showing a path the user has to open by hand.
 *
 * Deliberately *only* type and size: pixel dimensions are sniffed by the renderer
 * from the file on disk, because it is the side that needs them for aspect-correct
 * placement. Duplicating a full image-header parser here would buy the model
 * nothing it cannot read off the description line.
 */
export type ToolImage = {
  /** Absolute path, so a renderer with a different cwd can still find the file. */
  path: string;
  /** Workspace-relative path for display. */
  displayPath: string;
  mime: ImageMime;
  byteSize: number;
};

export type ImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/bmp";

/** Header bytes needed to identify every format we claim to support. */
export const IMAGE_SNIFF_BYTES = 16;

/**
 * Identify an image by magic bytes only. Extensions lie and are absent on
 * generated temp files, so the bytes are the source of truth.
 */
export function detectImageMime(buffer: Buffer): ImageMime | undefined {
  if (buffer.length < 4) return undefined;
  if (buffer.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => buffer[index] === byte)) return "image/png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 6 && ["GIF87a", "GIF89a"].includes(buffer.toString("ascii", 0, 6))) return "image/gif";
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (buffer.toString("ascii", 0, 2) === "BM") return "image/bmp";
  return undefined;
}

/**
 * Describe an on-disk image for a tool result. Returns undefined when the file is
 * not a recognized image, so callers can fall through to their normal handling.
 */
export async function describeToolImage(absolutePath: string, cwd: string): Promise<ToolImage | undefined> {
  let byteSize: number;
  try {
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile()) return undefined;
    byteSize = stat.size;
  } catch {
    return undefined;
  }
  const mime = detectImageMime(await readHeader(absolutePath));
  if (!mime) return undefined;
  const displayPath = path.relative(cwd, absolutePath) || path.basename(absolutePath);
  return { path: absolutePath, displayPath, mime, byteSize };
}

/**
 * The text a tool returns *instead of* image bytes. The model cannot see pixels
 * through a tool result, so it gets an honest description rather than megabytes
 * of binary reinterpreted as UTF-8 — which is both useless and context-expensive.
 */
export function describeToolImageForModel(image: ToolImage): string {
  return `[image] ${image.displayPath} · ${image.mime} · ${formatBytes(image.byteSize)}\nThis file is binary image data and is not readable as text. It is displayed to the user inline.`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function readHeader(absolutePath: string): Promise<Buffer> {
  const handle = await fs.open(absolutePath, "r");
  try {
    const buffer = Buffer.alloc(IMAGE_SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, IMAGE_SNIFF_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
