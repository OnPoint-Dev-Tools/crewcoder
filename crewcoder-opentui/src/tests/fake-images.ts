import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import type { ClipboardSource } from "../attachments.js";

/** A PNG header with real IHDR dimensions; enough for `sniffImage`, never decoded. */
export function pngBytes(width = 800, height = 600): Buffer {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

/** A real, decodable RGB PNG filled with one color (8-bit, no filtering). */
export function solidPng(width: number, height: number, rgb: readonly [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8); // bit depth
  header.writeUInt8(2, 9); // color type: RGB
  // Each scanline: filter byte 0, then the pixels.
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => rgb).flat())]);
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

/** Write a decodable one-color PNG into a fresh temp directory and return its path. */
export function solidPngFile(name: string, width: number, height: number, rgb: readonly [number, number, number]): string {
  const file = join(mkdtempSync(join(tmpdir(), "crewcoder-img-")), name);
  writeFileSync(file, solidPng(width, height, rgb));
  return file;
}

/** Write a PNG into a fresh temp directory and return its path. */
export function pngFile(name = "shot.png", width = 640, height = 480): string {
  const file = join(mkdtempSync(join(tmpdir(), "crewcoder-img-")), name);
  writeFileSync(file, pngBytes(width, height));
  return file;
}

/** Scripted clipboard: an image, text, or nothing. */
export function fakeClipboard(content: { image?: Buffer; text?: string } = {}): ClipboardSource {
  return {
    image: () => (content.image ? { mime: "image/png", data: content.image } : undefined),
    text: () => content.text
  };
}

/** Point the image cache at a temp CREWCODER_HOME; returns a restore function. */
export function isolateImageCache(): () => void {
  const previous = process.env.CREWCODER_HOME;
  process.env.CREWCODER_HOME = mkdtempSync(join(tmpdir(), "crewcoder-home-"));
  return () => {
    if (previous === undefined) delete process.env.CREWCODER_HOME;
    else process.env.CREWCODER_HOME = previous;
  };
}
