import { describe, expect, it, vi } from "vitest";
import {
  compositeLiveUiFrame,
  compositeLiveUiLines,
  flattenLiveUiFrame,
  LiveUiRepaintScheduler,
  sanitizeLiveUiLine,
  type LiveUiFrameStyle
} from "../bridge/live-ui-frame.js";
import { stripAnsi, visibleLength } from "../tui/ansi.js";
import type { LiveUiFrame } from "../bridge/live-ui-protocol.js";

const theme = { border: "#18372c", focusBorder: "#285a48", title: "#cccccc", text: "#ffffff" };

function style(overrides: Partial<LiveUiFrameStyle> = {}): LiveUiFrameStyle {
  return { width: 20, height: 6, focused: false, title: "review-pack/panel", theme, ...overrides };
}

function frame(lines: string[]): LiveUiFrame {
  return { width: 10, height: lines.length, lines: lines.map((line) => [{ text: line }]) };
}

describe("sanitizeLiveUiLine", () => {
  it("strips ANSI and control characters", () => {
    const dirty = "\x1b[31mred\x1b[0m\x07\x00text";
    const clean = sanitizeLiveUiLine(dirty);
    expect(clean).not.toContain("\x1b");
    expect(clean).not.toContain("\x07");
    expect(clean).toContain("red");
    expect(clean).toContain("text");
  });

  it("expands tabs to spaces", () => {
    expect(sanitizeLiveUiLine("a\tb")).toBe("a  b");
  });
});

describe("flattenLiveUiFrame", () => {
  it("concatenates cells per row", () => {
    const f: LiveUiFrame = { width: 6, height: 2, lines: [[{ text: "ab" }, { text: "cd" }], [{ text: "ef" }]] };
    expect(flattenLiveUiFrame(f)).toEqual(["abcd", "ef"]);
  });
});

describe("compositeLiveUiFrame", () => {
  it("produces a bordered box sized to the surface", () => {
    const out = compositeLiveUiFrame(frame(["hello", "world"]), style({ width: 20, height: 6 }));
    expect(out).toHaveLength(6);
    for (const line of out) expect(visibleLength(line)).toBe(20);
    expect(stripAnsi(out.join("\n"))).toContain("review-pack/panel");
    expect(stripAnsi(out.join("\n"))).toContain("hello");
  });

  it("marks focus with a different border color and a focus glyph", () => {
    const unfocused = compositeLiveUiFrame(frame(["x"]), style({ focused: false }));
    const focused = compositeLiveUiFrame(frame(["x"]), style({ focused: true }));
    expect(unfocused[0]).not.toBe(focused[0]);
    expect(stripAnsi(focused.join("\n"))).toContain("●");
  });

  it("clips child text wider than the surface", () => {
    const out = compositeLiveUiLines(["x".repeat(200)], style({ width: 12 }));
    for (const line of out) expect(visibleLength(line)).toBe(12);
  });

  it("enforces the output byte budget by collapsing to a marker", () => {
    const out = compositeLiveUiLines(Array.from({ length: 50 }, (_, i) => `line ${i}`), style({ width: 30, height: 40, maxOutputBytes: 80 }));
    expect(stripAnsi(out.join("\n"))).toContain("byte budget");
  });

  it("can render unboxed content lines for status surfaces", () => {
    const out = compositeLiveUiFrame(frame(["hello", "world"]), style({ width: 20, height: 2, boxed: false }));
    expect(out).toHaveLength(2);
    for (const line of out) expect(visibleLength(line)).toBe(20);
    expect(stripAnsi(out.join("\n"))).toContain("hello");
    expect(stripAnsi(out.join("\n"))).toContain("world");
    expect(stripAnsi(out.join("\n"))).not.toContain("review-pack");
  });

  it("slices boxed content by scrollOffset", () => {
    const lines = ["line-0", "line-1", "line-2", "line-3", "line-4"];
    // height 6 -> top/bottom borders + title + 3 content rows.
    const out = compositeLiveUiFrame(frame(lines), style({ width: 20, height: 6, scrollOffset: 2 }));
    expect(out).toHaveLength(6);
    const text = stripAnsi(out.join("\n"));
    expect(text).toContain("line-2");
    expect(text).toContain("line-3");
    expect(text).toContain("line-4");
    expect(text).not.toContain("line-0");
    expect(text).not.toContain("line-1");
  });

  it("slices unboxed content by scrollOffset", () => {
    const lines = ["a", "b", "c", "d", "e"];
    const out = compositeLiveUiFrame(frame(lines), style({ width: 10, height: 2, boxed: false, scrollOffset: 2 }));
    expect(out).toHaveLength(2);
    expect(stripAnsi(out[0] ?? "")).toContain("c");
    expect(stripAnsi(out[1] ?? "")).toContain("d");
  });

  it("clamps a negative scrollOffset to zero", () => {
    const out = compositeLiveUiFrame(frame(["only"]), style({ width: 20, height: 5, scrollOffset: -10 }));
    expect(stripAnsi(out.join("\n"))).toContain("only");
  });
});

describe("LiveUiRepaintScheduler", () => {
  it("coalesces multiple requests into one scheduled repaint", () => {
    const repaint = vi.fn();
    const scheduled: Array<() => void> = [];
    const scheduler = new LiveUiRepaintScheduler(repaint, (cb) => scheduled.push(cb));
    scheduler.request();
    scheduler.request();
    scheduler.request();
    expect(scheduled).toHaveLength(1);
    expect(scheduler.hasPending).toBe(true);
    scheduled[0]?.();
    expect(repaint).toHaveBeenCalledTimes(1);
    expect(scheduler.hasPending).toBe(false);
  });

  it("does not repaint when nothing was requested", () => {
    const repaint = vi.fn();
    const scheduler = new LiveUiRepaintScheduler(repaint, () => {});
    scheduler.flush();
    expect(repaint).not.toHaveBeenCalled();
  });
});
