import { describe, expect, it } from "vitest";
import { applyTerminalBackground } from "../terminal-background.js";

const sink = (): { writes: string[]; write(chunk: string): void } => {
  const writes: string[] = [];
  return { writes, write: (chunk: string) => { writes.push(chunk); } };
};

describe("applyTerminalBackground", () => {
  it("sets the terminal background with OSC 11 and restores it once with OSC 111", () => {
    const out = sink();
    const reset = applyTerminalBackground(out, "#0c1014");
    reset();
    reset();

    expect(out.writes).toEqual(["\x1b]11;#0c1014\x07", "\x1b]111\x07"]);
  });

  it("refuses anything but #rrggbb so a theme value cannot inject terminal controls", () => {
    const out = sink();
    applyTerminalBackground(out, "#0c1014\x07\x1b]52;c;cHduZWQ=\x07")();
    applyTerminalBackground(out, "red")();

    expect(out.writes).toEqual([]);
  });
});
