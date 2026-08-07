import { describe, expect, it } from "vitest";
import { detectImageProtocol, encodeItermImage, encodeKittyDeleteImage, encodeKittyDeleteVisibleImages, encodeKittyImage, fitPlacement, kittyImageId } from "../tui/image-protocol.js";

describe("detectImageProtocol", () => {
  it("detects kitty via KITTY_WINDOW_ID", () => {
    expect(detectImageProtocol({ KITTY_WINDOW_ID: "1" })).toBe("kitty");
  });

  it("detects ghostty as kitty graphics", () => {
    expect(detectImageProtocol({ TERM_PROGRAM: "ghostty" })).toBe("kitty");
  });

  it("detects iTerm2", () => {
    expect(detectImageProtocol({ TERM_PROGRAM: "iTerm.app" })).toBe("iterm");
  });

  it("returns none for an unknown terminal", () => {
    expect(detectImageProtocol({ TERM: "xterm-256color" })).toBe("none");
  });

  it("honors an explicit override", () => {
    expect(detectImageProtocol({ KITTY_WINDOW_ID: "1", CREWCODER_TUI_IMAGE_PROTOCOL: "none" })).toBe("none");
    expect(detectImageProtocol({ CREWCODER_TUI_IMAGE_PROTOCOL: "iterm" })).toBe("iterm");
  });
});

describe("encoders", () => {
  it("base64-encodes the file path for kitty and includes the cell box", () => {
    const escape = encodeKittyImage("/tmp/shot.png", { cols: 40, rows: 12 }, "img_test");
    expect(escape.startsWith("\x1b_G")).toBe(true);
    expect(escape).toContain(`C=1,i=${kittyImageId("img_test")},c=40,r=12`);
    expect(escape).toContain(Buffer.from("/tmp/shot.png").toString("base64"));
    expect(escape.endsWith("\x1b\\")).toBe(true);
  });

  it("carries base64 data inline for iterm", () => {
    const escape = encodeItermImage("AAAA", { cols: 20, rows: 6 });
    expect(escape).toContain("\x1b]1337;File=");
    expect(escape).toContain("width=20;height=6");
    expect(escape).toContain(":AAAA");
  });

  it("builds kitty delete escapes", () => {
    expect(encodeKittyDeleteImage("img_test")).toBe(`\x1b_Ga=d,d=i,i=${kittyImageId("img_test")}\x1b\\`);
    expect(encodeKittyDeleteVisibleImages()).toBe("\x1b_Ga=d,d=V\x1b\\");
  });
});

describe("fitPlacement", () => {
  it("preserves aspect ratio within the box", () => {
    const placement = fitPlacement(1600, 400, 40, 20);
    expect(placement.cols).toBeLessThanOrEqual(40);
    expect(placement.rows).toBeLessThanOrEqual(20);
    expect(placement.cols).toBeGreaterThan(placement.rows);
  });

  it("does not squeeze wide screenshots into a tiny column", () => {
    expect(fitPlacement(1228, 518, 80, 8)).toEqual({ cols: 38, rows: 8 });
  });

  it("falls back to the full box when dimensions are unknown", () => {
    expect(fitPlacement(undefined, undefined, 30, 10)).toEqual({ cols: 30, rows: 10 });
  });
});
