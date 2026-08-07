import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeAttachment, formatBytes, imageCacheDir, persistImageBuffer, sniffImage } from "../state/image-attachment.js";

function pngBuffer(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function gifBuffer(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(10);
  buffer.write("GIF89a", 0, "ascii");
  buffer.writeUInt16LE(width, 6);
  buffer.writeUInt16LE(height, 8);
  return buffer;
}

function jpegBuffer(width: number, height: number): Buffer {
  // SOI, then a SOF0 frame segment carrying the dimensions.
  const buffer = Buffer.alloc(20);
  buffer[0] = 0xff; buffer[1] = 0xd8;
  buffer[2] = 0xff; buffer[3] = 0xc0;
  buffer.writeUInt16BE(17, 4); // segment length
  buffer[6] = 8; // precision
  buffer.writeUInt16BE(height, 7);
  buffer.writeUInt16BE(width, 9);
  return buffer;
}

describe("sniffImage", () => {
  it("reads PNG dimensions from the IHDR chunk", () => {
    expect(sniffImage(pngBuffer(1280, 720))).toEqual({ mime: "image/png", width: 1280, height: 720 });
  });

  it("reads GIF dimensions little-endian", () => {
    expect(sniffImage(gifBuffer(48, 32))).toEqual({ mime: "image/gif", width: 48, height: 32 });
  });

  it("reads JPEG dimensions by scanning to the start-of-frame marker", () => {
    expect(sniffImage(jpegBuffer(640, 480))).toEqual({ mime: "image/jpeg", width: 640, height: 480 });
  });

  it("returns undefined for non-image data", () => {
    expect(sniffImage(Buffer.from("not an image at all"))).toBeUndefined();
  });
});

describe("formatBytes", () => {
  it("scales units", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("persistImageBuffer", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-img-"));
    process.env.CREWCODER_HOME = home;
  });

  afterEach(() => {
    delete process.env.CREWCODER_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("writes the buffer into the cache dir and returns its metadata", () => {
    const buffer = pngBuffer(800, 600);
    const attachment = persistImageBuffer(buffer, { mime: "image/png", width: 800, height: 600 });

    expect(attachment.path.startsWith(imageCacheDir())).toBe(true);
    expect(fs.existsSync(attachment.path)).toBe(true);
    expect(attachment.byteSize).toBe(buffer.length);
    expect(attachment.name.endsWith(".png")).toBe(true);
    expect(describeAttachment(attachment)).toBe(`800×600 · ${formatBytes(buffer.length)}`);
  });
});
