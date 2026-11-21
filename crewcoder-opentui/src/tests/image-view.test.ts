import { describe, expect, it } from "vitest";
import { IMAGE_PROTOCOL_ENV, imageBox, MAX_IMAGE_COLS, MAX_IMAGE_ROWS, MIN_IMAGE_ROWS, resolveImageMode } from "../image-view.js";

describe("resolveImageMode", () => {
  it("follows the terminal unless overridden", () => {
    expect(resolveImageMode({}, false)).toBe("auto");
    expect(resolveImageMode({ [IMAGE_PROTOCOL_ENV]: " Kitty " }, false)).toBe("kitty");
    expect(resolveImageMode({ [IMAGE_PROTOCOL_ENV]: "sixel" }, false)).toBe("sixel");
    expect(resolveImageMode({ [IMAGE_PROTOCOL_ENV]: "blocks" }, false)).toBe("blocks");
    expect(resolveImageMode({ [IMAGE_PROTOCOL_ENV]: "none" }, false)).toBe("none");
    expect(resolveImageMode({ [IMAGE_PROTOCOL_ENV]: "off" }, false)).toBe("none");
  });

  it("treats protocols OpenTUI does not speak (legacy iterm) and junk as auto", () => {
    expect(resolveImageMode({ [IMAGE_PROTOCOL_ENV]: "iterm" }, false)).toBe("auto");
    expect(resolveImageMode({ [IMAGE_PROTOCOL_ENV]: "bogus" }, false)).toBe("auto");
  });

  it("draws no pixels for a remote workspace, whatever the override", () => {
    expect(resolveImageMode({}, true)).toBe("none");
    expect(resolveImageMode({ [IMAGE_PROTOCOL_ENV]: "kitty" }, true)).toBe("none");
  });
});

describe("imageBox", () => {
  it("keeps a wide image's shape inside the column cap", () => {
    // 1600x400 is 4:1; cells are twice as tall, so 8 columns per row.
    expect(imageBox(1600, 400, 120, 60)).toEqual({ cols: MAX_IMAGE_COLS, rows: 10 });
  });

  it("caps a tall image by rows and narrows it to keep the shape", () => {
    expect(imageBox(400, 1600, 120, 60)).toEqual({ cols: 9, rows: MAX_IMAGE_ROWS });
  });

  it("uses 35% of the screen, never below the minimum rows", () => {
    expect(imageBox(800, 800, 120, 30)).toEqual({ cols: 20, rows: 10 });
    expect(imageBox(800, 800, 120, 5)).toEqual({ cols: 8, rows: MIN_IMAGE_ROWS });
  });

  it("never exceeds the available columns", () => {
    expect(imageBox(1600, 400, 30, 60)).toEqual({ cols: 30, rows: 4 });
    expect(imageBox(1600, 400, 0, 60).cols).toBe(1);
  });

  it("takes the whole cap when the dimensions are unknown", () => {
    expect(imageBox(undefined, 600, 120, 60)).toEqual({ cols: MAX_IMAGE_COLS, rows: MAX_IMAGE_ROWS });
  });
});
