import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
