import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attachImagePaths, pasteFromClipboard } from "../attachments.js";
import { fakeClipboard, isolateImageCache, pngBytes, pngFile } from "./fake-images.js";

let restore: () => void;
beforeEach(() => {
  restore = isolateImageCache();
});
afterEach(() => restore());

describe("pasteFromClipboard", () => {
  it("attaches a clipboard image to the CrewCoder cache with its dimensions", () => {
    const result = pasteFromClipboard(fakeClipboard({ image: pngBytes(1280, 720), text: "ignored" }), []);
    expect(result.text).toBeUndefined();
    expect(result.attached).toHaveLength(1);
    expect(result.attached[0]).toMatchObject({ mime: "image/png", width: 1280, height: 720, source: "clipboard" });
    expect(result.attached[0]!.path.startsWith(process.env.CREWCODER_HOME!)).toBe(true);
    expect(existsSync(result.attached[0]!.path)).toBe(true);
  });

  it("attaches image files named in clipboard text, else returns the text", () => {
    const file = pngFile();
    expect(pasteFromClipboard(fakeClipboard({ text: `look ${file}` }), []).attached).toHaveLength(1);
    expect(pasteFromClipboard(fakeClipboard({ text: "plain words" }), [])).toEqual({ attached: [], text: "plain words" });
    expect(pasteFromClipboard(fakeClipboard(), [])).toEqual({ attached: [] });
  });
});

describe("attachImagePaths", () => {
  it("skips missing files, non-images, and images already attached", () => {
    const file = pngFile();
    const first = attachImagePaths(`${file} /tmp/nope-${Date.now()}.png`, []);
    expect(first).toHaveLength(1);
    expect(attachImagePaths(file, first)).toEqual([]);
  });
});
