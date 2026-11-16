import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Phase 1 image attachments: paste a screenshot, persist it to the CrewCoder
// cache, and carry enough metadata (mime + pixel dimensions + byte size) for the
// TUI to render a preview without re-reading the file. Dimension sniffing is done
// from the raw header bytes so we stay dependency-free and never decode pixels.

export type ImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/bmp";

export type ImageInfo = { mime: ImageMime; width?: number; height?: number };

export type ImageAttachmentSource = "clipboard" | "file" | "tool";

export type ImageAttachment = {
  id: string;
  path: string;
  name: string;
  mime: ImageMime;
  width?: number;
  height?: number;
  byteSize: number;
  source: ImageAttachmentSource;
};

const MIME_EXTENSION: Record<ImageMime, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp"
};

/**
 * Detect image type and pixel dimensions from the leading header bytes. Returns
 * undefined when the buffer is not a recognized image. Dimensions may be omitted
 * for malformed/partial headers even when the magic bytes match a known type.
 */
export function sniffImage(buffer: Buffer): ImageInfo | undefined {
  if (buffer.length < 4) return undefined;
  return sniffPng(buffer) ?? sniffGif(buffer) ?? sniffBmp(buffer) ?? sniffWebp(buffer) ?? sniffJpeg(buffer);
}

function sniffPng(buffer: Buffer): ImageInfo | undefined {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buffer.length < 24 || !signature.every((byte, index) => buffer[index] === byte)) return undefined;
  // IHDR is the first chunk: 8-byte sig, 4-byte length, 4-byte "IHDR", then width/height.
  if (buffer.toString("ascii", 12, 16) !== "IHDR") return { mime: "image/png" };
  return { mime: "image/png", width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function sniffGif(buffer: Buffer): ImageInfo | undefined {
  const header = buffer.toString("ascii", 0, 6);
  if (header !== "GIF87a" && header !== "GIF89a") return undefined;
  if (buffer.length < 10) return { mime: "image/gif" };
  return { mime: "image/gif", width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
}

function sniffBmp(buffer: Buffer): ImageInfo | undefined {
  if (buffer.toString("ascii", 0, 2) !== "BM") return undefined;
  if (buffer.length < 26) return { mime: "image/bmp" };
  return { mime: "image/bmp", width: Math.abs(buffer.readInt32LE(18)), height: Math.abs(buffer.readInt32LE(22)) };
}

function sniffWebp(buffer: Buffer): ImageInfo | undefined {
  if (buffer.length < 16 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP") return undefined;
  const format = buffer.toString("ascii", 12, 16);
  if (format === "VP8 " && buffer.length >= 30) {
    return { mime: "image/webp", width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  if (format === "VP8L" && buffer.length >= 25) {
    const bits = buffer.readUInt32LE(21);
    return { mime: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (format === "VP8X" && buffer.length >= 30) {
    const width = 1 + (buffer[24]! | (buffer[25]! << 8) | (buffer[26]! << 16));
    const height = 1 + (buffer[27]! | (buffer[28]! << 8) | (buffer[29]! << 16));
    return { mime: "image/webp", width, height };
  }
  return { mime: "image/webp" };
}

function sniffJpeg(buffer: Buffer): ImageInfo | undefined {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    const marker = buffer[offset + 1]!;
    // SOF0..SOF15 (excluding the non-frame DHT/JPG/DAC markers) carry the frame size.
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      return { mime: "image/jpeg", height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    const segmentLength = buffer.readUInt16BE(offset + 2);
    if (segmentLength < 2) break;
    offset += 2 + segmentLength;
  }
  return { mime: "image/jpeg" };
}

export function imageCacheDir(): string {
  return path.join(crewcoderHome(), "cache", "images");
}

function crewcoderHome(): string {
  const override = process.env.CREWCODER_HOME?.trim();
  if (override) return path.resolve(override);
  return path.join(process.env.HOME || os.homedir(), ".crewcoder");
}

/**
 * Write an image buffer to the CrewCoder cache and return its attachment record.
 * The on-disk path is what later gets handed to the model (Phase 2), so it must
 * survive the TUI process: we deliberately persist instead of holding bytes in RAM.
 */
export function persistImageBuffer(buffer: Buffer, info: ImageInfo, source: ImageAttachmentSource = "clipboard", preferredName?: string): ImageAttachment {
  const dir = imageCacheDir();
  fs.mkdirSync(dir, { recursive: true });
  const id = createAttachmentId();
  const extension = MIME_EXTENSION[info.mime];
  const safeName = preferredName ? sanitizeFileName(preferredName, extension) : undefined;
  const name = safeName ? `${id}-${safeName}` : `${id}.${extension}`;
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, buffer);
  return { id, path: filePath, name, mime: info.mime, width: info.width, height: info.height, byteSize: buffer.length, source };
}

/**
 * Build a renderable attachment from a `details.images[]` entry emitted by a tool.
 *
 * Unlike pasted images this does **not** copy anything into the cache: the file
 * already lives in the workspace and copying every screenshot a tool touches would
 * quietly grow the cache without bound. We read only the header to sniff pixel
 * dimensions, and we re-sniff rather than trusting the payload — the mime a tool
 * reports is a claim, the bytes are the fact.
 *
 * Returns undefined for anything that is not a readable image on disk, so a
 * malformed or stale tool payload degrades to the plain tool output.
 */
export function attachmentFromToolImage(raw: unknown, index = 0): ImageAttachment | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const filePath = typeof record.path === "string" ? record.path.trim() : "";
  if (!filePath) return undefined;

  const resolved = path.resolve(filePath);
  let header: Buffer;
  let byteSize: number;
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return undefined;
    byteSize = stat.size;
    header = readHeaderBytes(resolved);
  } catch {
    return undefined;
  }

  const info = sniffImage(header);
  if (!info) return undefined;
  const displayPath = typeof record.displayPath === "string" && record.displayPath.trim() ? record.displayPath.trim() : path.basename(resolved);
  return {
    id: `toolimg_${kittySafeId(resolved)}_${index}`,
    path: resolved,
    name: displayPath,
    mime: info.mime,
    width: info.width,
    height: info.height,
    byteSize,
    source: "tool"
  };
}

/** Extract every renderable image declared on a tool result's metadata. */
export function toolImageAttachments(metadata: Record<string, unknown> | undefined): ImageAttachment[] {
  const raw = metadata?.images;
  if (!Array.isArray(raw)) return [];
  return raw.map((entry, index) => attachmentFromToolImage(entry, index)).filter((entry): entry is ImageAttachment => Boolean(entry));
}

/**
 * Header-only read. Image dimensions live in the first bytes of every format we
 * support, so a 40 MB screenshot never gets loaded into memory to be measured.
 */
function readHeaderBytes(filePath: string, bytes = 64 * 1024): Buffer {
  const handle = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const read = fs.readSync(handle, buffer, 0, bytes, 0);
    return buffer.subarray(0, read);
  } finally {
    fs.closeSync(handle);
  }
}

/** Stable, filesystem-safe id fragment so the same file reuses one graphics placement. */
function kittySafeId(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function persistImageFile(filePath: string): ImageAttachment | undefined {
  const resolved = path.resolve(filePath);
  let buffer: Buffer;
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return undefined;
    buffer = fs.readFileSync(resolved);
  } catch {
    return undefined;
  }
  const info = sniffImage(buffer);
  if (!info) return undefined;
  return persistImageBuffer(buffer, info, "file", path.basename(resolved));
}

function sanitizeFileName(name: string, extension: string): string {
  const fallback = `image.${extension}`;
  const base = path.basename(name).replaceAll(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "");
  const safe = base || fallback;
  return safe.includes(".") ? safe : `${safe}.${extension}`;
}

function createAttachmentId(): string {
  return `img_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function describeAttachment(attachment: ImageAttachment): string {
  const dimensions = attachment.width && attachment.height ? `${attachment.width}×${attachment.height}` : "image";
  return `${dimensions} · ${formatBytes(attachment.byteSize)}`;
}
