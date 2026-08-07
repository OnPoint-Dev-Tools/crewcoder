import { describe, expect, it } from "vitest";
import { InputFocusGate, parseInputEvents } from "../tui/input.js";

describe("InputRouter parser", () => {
  it("normalizes common shift-enter terminal escape sequences", () => {
    for (const sequence of ["\u001b[13;2u", "\u001b[13;2~", "\u001b[13~", "\u001b[27;2;13~"]) {
      expect(parseInputEvents(sequence)).toEqual([{
        name: "return",
        sequence,
        ctrl: false,
        meta: false,
        shift: true
      }]);
    }
  });

  it("does not leak shift-enter bytes as printable input", () => {
    const events = parseInputEvents(`first\u001b[13~second`);

    expect(events.map((event) => event.sequence).join("")).toBe("first\u001b[13~second");
    expect(events.some((event) => event.sequence === "1" || event.sequence === "3" || event.sequence === "~")).toBe(false);
    expect(events.find((event) => event.name === "return")).toMatchObject({ shift: true });
  });

  it("parses focus reports and gates input to the focused terminal instance", () => {
    const events = parseInputEvents("a\u001b[Ob\u001b[Ic");
    expect(events.map((event) => event.name)).toEqual(["a", "focus_out", "b", "focus_in", "c"]);

    const gate = new InputFocusGate();
    expect(events.filter((event) => gate.accept(event)).map((event) => event.name)).toEqual(["a", "c"]);
  });

  it("parses control-letter key chords", () => {
    expect(parseInputEvents("\u000f")).toEqual([{
      name: "o",
      sequence: "\u000f",
      ctrl: true,
      meta: false,
      shift: false
    }]);
  });

  it("parses SGR mouse wheel events", () => {
    expect(parseInputEvents("\u001b[<64;20;10M")).toEqual([{
      name: "wheelup",
      sequence: "\u001b[<64;20;10M",
      ctrl: false,
      meta: false,
      shift: false,
      mouse: { x: 20, y: 10, button: 64, kind: "wheel" }
    }]);
    expect(parseInputEvents("\u001b[<65;20;10M")).toEqual([{
      name: "wheeldown",
      sequence: "\u001b[<65;20;10M",
      ctrl: false,
      meta: false,
      shift: false,
      mouse: { x: 20, y: 10, button: 65, kind: "wheel" }
    }]);
  });

  it("parses non-wheel SGR mouse events with coordinates", () => {
    expect(parseInputEvents("\u001b[<0;20;10M")).toEqual([{
      name: "mouse",
      sequence: "\u001b[<0;20;10M",
      ctrl: false,
      meta: false,
      shift: false,
      mouse: { x: 20, y: 10, button: 0, kind: "press" }
    }]);
    expect(parseInputEvents("\u001b[<32;21;10M")[0]).toMatchObject({ mouse: { x: 21, y: 10, button: 32, kind: "drag" } });
    expect(parseInputEvents("\u001b[<35;23;10M")[0]).toMatchObject({ mouse: { x: 23, y: 10, button: 35, kind: "hover" } });
    expect(parseInputEvents("\u001b[<0;22;10m")[0]).toMatchObject({ mouse: { x: 22, y: 10, button: 0, kind: "release" } });
  });

  it("swallows OSC terminal reports instead of typing them as text", () => {
    const ESC = String.fromCharCode(27);
    const ST = ESC + "\\";
    const events = parseInputEvents(`hi${ESC}]11;rgb:0f0f/1212/0f0f${ST}bye`);
    expect(events.map((event) => event.sequence).join("")).toBe("hibye");
    expect(events.some((event) => event.sequence.includes("rgb"))).toBe(false);
  });

  it("swallows OSC reports terminated by BEL", () => {
    const ESC = String.fromCharCode(27);
    const BEL = String.fromCharCode(7);
    const events = parseInputEvents(`${ESC}]11;rgb:0f0f/1212/0f0f${BEL}x`);
    expect(events).toEqual([{ name: "x", sequence: "x", ctrl: false, meta: false, shift: false }]);
  });

  it("swallows legacy X10 mouse reports without leaking coordinate bytes", () => {
    const ESC = String.fromCharCode(27);
    const coords = String.fromCharCode(32, 33, 34);
    const events = parseInputEvents(`${ESC}[M${coords}next`);
    expect(events.map((event) => event.sequence).join("")).toBe("next");
  });

  it("parses application keypad enter as return", () => {
    expect(parseInputEvents("\u001bOM")).toEqual([{
      name: "return",
      sequence: "\u001bOM",
      ctrl: false,
      meta: false,
      shift: false
    }]);
  });

  it("parses normal, application, and modified arrow key sequences", () => {
    expect(parseInputEvents("\u001b[A")[0]).toMatchObject({ name: "up", ctrl: false, meta: false, shift: false });
    expect(parseInputEvents("\u001bOB")[0]).toMatchObject({ name: "down", ctrl: false, meta: false, shift: false });
    expect(parseInputEvents("\u001b[1;1A")[0]).toMatchObject({ name: "up", ctrl: false, meta: false, shift: false });
    expect(parseInputEvents("\u001b[1;5B")[0]).toMatchObject({ name: "down", ctrl: true, meta: false, shift: false });
  });

  it("parses modified navigation key sequences", () => {
    expect(parseInputEvents("\u001b[5;2~")[0]).toMatchObject({ name: "pageup", shift: true });
    expect(parseInputEvents("\u001b[6;5~")[0]).toMatchObject({ name: "pagedown", ctrl: true });
  });
});
