import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeToolImage, describeToolImageForModel, detectImageMime } from "../core/tool-images.js";
import { readTool } from "../tools/read.js";
import type { ToolContext } from "../core/tool-types.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-tool-images-"));
});

afterEach(() => {
  fs.rmSync(dir, { force: true, recursive: true });
});

function pngBuffer(width = 4, height = 3): Buffer {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function context(): ToolContext {
  return { cwd: dir, mode: "general", sessionId: "sess_test", mutationLog: [] };
}

describe("detectImageMime", () => {
  it("identifies supported formats by magic bytes", () => {
    expect(detectImageMime(pngBuffer())).toBe("image/png");
    expect(detectImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(detectImageMime(Buffer.from("GIF89a....", "ascii"))).toBe("image/gif");
    expect(detectImageMime(Buffer.from("BM__________", "ascii"))).toBe("image/bmp");
    const webp = Buffer.alloc(16);
    webp.write("RIFF", 0, "ascii");
    webp.write("WEBP", 8, "ascii");
    expect(detectImageMime(webp)).toBe("image/webp");
  });

  it("does not identify text or truncated buffers as images", () => {
    expect(detectImageMime(Buffer.from("export const x = 1;\n", "utf8"))).toBeUndefined();
    expect(detectImageMime(Buffer.from([0x89]))).toBeUndefined();
  });

  it("ignores the file extension and trusts the bytes", async () => {
    // A text file named .png must not be treated as an image.
    fs.writeFileSync(path.join(dir, "liar.png"), "not actually an image", "utf8");
    expect(await describeToolImage(path.join(dir, "liar.png"), dir)).toBeUndefined();
  });
});

describe("describeToolImage", () => {
  it("describes an on-disk image with an absolute path and a relative display path", async () => {
    const file = path.join(dir, "nested", "shot.png");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, pngBuffer());

    const image = await describeToolImage(file, dir);
    expect(image).toMatchObject({ path: file, displayPath: path.join("nested", "shot.png"), mime: "image/png", byteSize: 24 });
  });

  it("returns undefined for a missing file or a directory", async () => {
    expect(await describeToolImage(path.join(dir, "nope.png"), dir)).toBeUndefined();
    expect(await describeToolImage(dir, dir)).toBeUndefined();
  });

  it("tells the model plainly that it cannot read the pixels", async () => {
    const file = path.join(dir, "shot.png");
    fs.writeFileSync(file, pngBuffer());
    const text = describeToolImageForModel((await describeToolImage(file, dir))!);
    expect(text).toContain("shot.png");
    expect(text).toContain("image/png");
    expect(text).toContain("not readable as text");
  });
});

describe("read tool image handling", () => {
  it("declares the image on details.images instead of returning binary as text", async () => {
    fs.writeFileSync(path.join(dir, "shot.png"), pngBuffer(1920, 1080));

    const result = await readTool.execute(readTool.parse({ path: "shot.png" }), context());
    const images = result.details?.images as Array<Record<string, unknown>>;

    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ displayPath: "shot.png", mime: "image/png" });
    // The raw PNG signature must never reach the model's context.
    expect(result.content[0]?.text).not.toContain("IHDR");
    expect(result.content[0]?.text).toContain("[image]");
  });

  it("still reads normal text files unchanged and declares no images", async () => {
    fs.writeFileSync(path.join(dir, "a.ts"), "export const x = 1;\n", "utf8");

    const result = await readTool.execute(readTool.parse({ path: "a.ts" }), context());

    expect(result.content[0]?.text).toBe("export const x = 1;\n");
    expect(result.details?.images).toBeUndefined();
    expect(result.details).toMatchObject({ path: "a.ts", truncated: false });
  });

  it("still truncates large text files", async () => {
    fs.writeFileSync(path.join(dir, "big.txt"), "x".repeat(500), "utf8");
    const result = await readTool.execute(readTool.parse({ path: "big.txt", maxBytes: 100 }), context());
    expect(result.content[0]?.text).toContain("x".repeat(100));
    expect(Buffer.byteLength(result.content[0]?.text ?? "", "utf8")).toBeLessThan(250);
    expect(result.details).toMatchObject({ truncated: true, bytes: 500, outputLines: 1 });
  });
});
