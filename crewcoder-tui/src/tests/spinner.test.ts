import { describe, expect, it } from "vitest";
import { LARGE_SPINNER_FRAMES, SPINNER_FRAMES, SPINNER_FRAME_MS, renderLargeSpinner, renderSpinner, spinnerFrame } from "../components/Spinner.js";
import { stripAnsi } from "../tui/ansi.js";

describe("spinnerFrame", () => {
  it("returns the first frame at time zero", () => {
    expect(spinnerFrame(0)).toBe(SPINNER_FRAMES[0]);
  });

  it("advances one frame per SPINNER_FRAME_MS", () => {
    expect(spinnerFrame(SPINNER_FRAME_MS)).toBe(SPINNER_FRAMES[1]);
    expect(spinnerFrame(SPINNER_FRAME_MS * 2)).toBe(SPINNER_FRAMES[2]);
  });

  it("wraps back to the first frame after a full cycle", () => {
    const cycle = SPINNER_FRAME_MS * SPINNER_FRAMES.length;
    expect(spinnerFrame(cycle)).toBe(SPINNER_FRAMES[0]);
  });

  it("only ever yields single-width glyphs", () => {
    for (const frame of SPINNER_FRAMES) {
      expect([...frame]).toHaveLength(1);
    }
  });
});

describe("renderSpinner", () => {
  it("wraps the frame in color and resets, leaving a single visible glyph", () => {
    const output = renderSpinner("#72dfcf", 0);
    expect(output).toContain(SPINNER_FRAMES[0]);
    expect(stripAnsi(output)).toBe(SPINNER_FRAMES[0]);
  });

  it("renders a larger two-cell logo sweep for prominent loading states", () => {
    const output = renderLargeSpinner("#72dfcf", 0);
    expect(stripAnsi(output)).toBe(LARGE_SPINNER_FRAMES[0]);
  });
});
