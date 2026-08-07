import { describe, expect, it } from "vitest";
import { createStallDetector, toolCallSignature } from "../core/stall-detector.js";

const ok = { isError: false };
const bad = { isError: true };

describe("stall detector", () => {
  it("trips when the same tool call repeats back-to-back", () => {
    const detector = createStallDetector({ repeatThreshold: 3, errorThreshold: 8 });
    expect(detector.record({ name: "grep", arguments: { pattern: "x" }, ...bad })).toBeUndefined();
    expect(detector.record({ name: "grep", arguments: { pattern: "x" }, ...bad })).toBeUndefined();
    expect(detector.record({ name: "grep", arguments: { pattern: "x" }, ...bad })).toContain("3 times in a row");
  });

  it("ignores argument key ordering when comparing calls", () => {
    const detector = createStallDetector({ repeatThreshold: 2, errorThreshold: 8 });
    expect(detector.record({ name: "grep", arguments: { a: 1, b: 2 }, ...ok })).toBeUndefined();
    expect(detector.record({ name: "grep", arguments: { b: 2, a: 1 }, ...ok })).toContain("2 times in a row");
  });

  it("resets the repeat counter when the agent does something different", () => {
    const detector = createStallDetector({ repeatThreshold: 3, errorThreshold: 8 });
    detector.record({ name: "grep", arguments: { pattern: "x" }, ...ok });
    detector.record({ name: "grep", arguments: { pattern: "x" }, ...ok });
    detector.record({ name: "read", arguments: { path: "a.ts" }, ...ok });
    expect(detector.record({ name: "grep", arguments: { pattern: "x" }, ...ok })).toBeUndefined();
  });

  it("trips on a run of consecutive failures with different arguments", () => {
    const detector = createStallDetector({ repeatThreshold: 99, errorThreshold: 4 });
    expect(detector.record({ name: "grep", arguments: { pattern: "a" }, ...bad })).toBeUndefined();
    expect(detector.record({ name: "grep", arguments: { pattern: "b" }, ...bad })).toBeUndefined();
    expect(detector.record({ name: "grep", arguments: { pattern: "c" }, ...bad })).toBeUndefined();
    expect(detector.record({ name: "grep", arguments: { pattern: "d" }, ...bad })).toContain("4 consecutive tool calls failed");
  });

  it("resets the error counter on any success", () => {
    const detector = createStallDetector({ repeatThreshold: 99, errorThreshold: 3 });
    detector.record({ name: "grep", arguments: { pattern: "a" }, ...bad });
    detector.record({ name: "grep", arguments: { pattern: "b" }, ...bad });
    detector.record({ name: "read", arguments: { path: "a.ts" }, ...ok });
    expect(detector.record({ name: "grep", arguments: { pattern: "c" }, ...bad })).toBeUndefined();
  });

  it("never trips on a long healthy run", () => {
    const detector = createStallDetector();
    for (let index = 0; index < 500; index += 1) {
      expect(detector.record({ name: "read", arguments: { path: `file-${index}.ts` }, ...ok })).toBeUndefined();
    }
  });

  it("builds order-independent signatures", () => {
    expect(toolCallSignature("grep", { a: 1, b: [2, 3] })).toBe(toolCallSignature("grep", { b: [2, 3], a: 1 }));
    expect(toolCallSignature("grep", { a: 1 })).not.toBe(toolCallSignature("grep", { a: 2 }));
  });
});
