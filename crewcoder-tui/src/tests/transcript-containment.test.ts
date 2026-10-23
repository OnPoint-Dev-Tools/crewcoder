import { describe, expect, it } from "vitest";
import { MainViewport } from "../components/MainViewport.js";
import { createInitialState } from "../state/tui-store.js";
import { stripAnsi } from "../tui/ansi.js";
import { padRight, splitLines } from "../tui/layout.js";
import { crewCoderTheme } from "../theme/theme.js";

describe("transcript row containment", () => {
  it("normalizes Windows line endings before laying out tool output", () => {
    expect(splitLines("first\r\n\tsecond\r\nlast")).toEqual(["first", "    second", "last"]);
    const state = createInitialState();
    state.blocks = [{ type: "tool", name: "Codex command", status: "done",
      text: "const first = 1;\r\n\treturn first;\r\nlast readable row" }];
    const { lines } = new MainViewport(state).layoutTranscript({ theme: crewCoderTheme, size: { width: 80, height: 24 } });
    expect(lines.join("")).not.toMatch(/[\r\n\t]/);
    expect(lines.map(stripAnsi).some((line) => line.includes("│     return first;"))).toBe(true);
    expect(lines.map(stripAnsi).join("\n")).toContain("last readable row");
  });

  it("contains cursor controls and embedded newlines even in a short padded row", () => {
    const row = padRight("before\x1b[2J\x1b[10;30Hafter\r\nend\x1b]0;title\x07", 40);
    expect(stripAnsi(row)).toBe("beforeafter  end".padEnd(40));
    expect(row).not.toContain("\x1b[2J");
    expect(row).not.toContain("\x1b[10;30H");
    expect(row).not.toMatch(/[\r\n\x07]/);
  });

  it("keeps colored tool output inside its rows before syntax highlighting", () => {
    const state = createInitialState();
    state.blocks = [{ type: "tool", name: "Codex command", status: "done",
      text: "\x1b[31mconst result = 42;\x1b[0m\r\n\x1b[20Cnext row" }];
    const { lines } = new MainViewport(state).layoutTranscript({ theme: crewCoderTheme, size: { width: 48, height: 24 } });
    const plain = lines.map(stripAnsi);
    expect(plain.some((line) => line.trim() === "│ const result = 42;")).toBe(true);
    expect(plain.some((line) => line.trim() === "│ next row")).toBe(true);
    expect(plain.every((line) => line.length === 48)).toBe(true);
    expect(lines.join("")).not.toContain("\x1b[20C");
  });
});
