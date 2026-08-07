import type { KeyEvent } from "./component.js";

export type InputHandler = (event: KeyEvent) => void;

type ParsedKey = Omit<KeyEvent, "sequence"> & { sequence?: string };

const CSI_FINAL = /[A-Za-z~u]/;

export class InputRouter {
  private handlers: InputHandler[] = [];
  private readonly focusGate = new InputFocusGate();
  private readonly onData = (chunk: Buffer | string) => {
    for (const event of parseInputEvents(chunk.toString("utf8"))) {
      if (!this.focusGate.accept(event)) continue;
      for (const handler of this.handlers) handler(event);
    }
  };

  start(): void {
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", this.onData);
  }

  onInput(handler: InputHandler): () => void {
    this.handlers.push(handler);
    return () => { this.handlers = this.handlers.filter((item) => item !== handler); };
  }

  stop(): void {
    process.stdin.off("data", this.onData);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}

export class InputFocusGate {
  private focused = true;

  accept(event: KeyEvent): boolean {
    if (event.name === "focus_in") { this.focused = true; return false; }
    if (event.name === "focus_out") { this.focused = false; return false; }
    return this.focused;
  }
}

export function parseInputEvents(input: string): KeyEvent[] {
  const events: KeyEvent[] = [];
  for (let index = 0; index < input.length;) {
    const parsed = parseAt(input, index);
    if (parsed) {
      // "ignore" marks consumed-but-discarded sequences (terminal reports, etc.).
      if (parsed.key.name !== "ignore") events.push(toKeyEvent(parsed.key, input.slice(index, parsed.nextIndex)));
      index = parsed.nextIndex;
      continue;
    }

    const sequence = input[index]!;
    events.push(toKeyEvent({ name: sequence, ctrl: false, meta: false, shift: false }, sequence));
    index += 1;
  }
  return events;
}

function parseAt(input: string, index: number): { key: ParsedKey; nextIndex: number } | undefined {
  const char = input[index];
  // Enter submits; a bare line-feed (Ctrl+J) inserts a newline as a universal fallback
  // for terminals that cannot report Shift+Enter distinctly. Raw mode guarantees the
  // Enter key itself arrives as "\r", so "\n" is unambiguously Ctrl+J here.
  if (char === "\r") return { key: { name: "return", ctrl: false, meta: false, shift: false }, nextIndex: index + 1 };
  if (char === "\n") return { key: { name: "return", ctrl: false, meta: true, shift: false }, nextIndex: index + 1 };
  if (char === "\u007f" || char === "\b") return { key: { name: "backspace", ctrl: false, meta: false, shift: false }, nextIndex: index + 1 };
  const controlKey = parseControlKey(char);
  if (controlKey) return { key: controlKey, nextIndex: index + 1 };
  if (char !== "\u001b") return undefined;

  // Alt/Option+Enter (ESC followed by CR/LF) is another universal newline fallback.
  if (input[index + 1] === "\r" || input[index + 1] === "\n") {
    return { key: { name: "return", ctrl: false, meta: true, shift: false }, nextIndex: index + 2 };
  }

  if (input[index + 1] === "O") {
    const applicationKey = parseApplicationKey(input[index + 2]);
    if (applicationKey) return { key: applicationKey, nextIndex: index + 3 };
  }

  // Legacy X10/normal mouse encoding: ESC [ M followed by 3 raw coordinate bytes. We
  // drive mouse via SGR (?1006), so just swallow these 6 bytes to stop their trailing
  // coordinate bytes from leaking into the composer (e.g. wheel scroll typing garbage).
  if (input[index + 1] === "[" && input[index + 2] === "M") {
    return { key: { name: "ignore", ctrl: false, meta: false, shift: false }, nextIndex: index + 6 };
  }

  // String sequences (OSC/DCS/APC/PM/SOS) are terminal replies (e.g. background-color
  // reports), not user input. Swallow them through their terminator so they never leak
  // into the composer as text.
  const stringIntro = input[index + 1];
  if (stringIntro === "]" || stringIntro === "P" || stringIntro === "_" || stringIntro === "^" || stringIntro === "X") {
    return { key: { name: "ignore", ctrl: false, meta: false, shift: false }, nextIndex: findStringTerminatorEnd(input, index + 2) };
  }

  if (input[index + 1] !== "[") {
    return { key: { name: "escape", ctrl: false, meta: false, shift: false }, nextIndex: index + 1 };
  }

  const end = findCsiEnd(input, index + 2);
  if (end === -1) {
    return { key: { name: "escape", ctrl: false, meta: false, shift: false }, nextIndex: index + 1 };
  }

  const sequence = input.slice(index, end + 1);
  return { key: parseCsi(sequence), nextIndex: end + 1 };
}

function findCsiEnd(input: string, start: number): number {
  for (let index = start; index < input.length; index++) {
    if (CSI_FINAL.test(input[index]!)) return index;
  }
  return -1;
}

function parseCsi(sequence: string): ParsedKey {
  if (sequence === "\u001b[I") return key("focus_in");
  if (sequence === "\u001b[O") return key("focus_out");
  const mouse = parseSgrMouse(sequence);
  if (mouse) return mouse;
  const cursor = parseCursorKey(sequence);
  if (cursor) return cursor;
  const navigation = parseNavigationKey(sequence);
  if (navigation) return navigation;
  const modified = parseModifiedKey(sequence);
  if (modified) return modified;
  // Unrecognized CSI sequences are almost always terminal reports (device attributes,
  // cursor position, protocol-query replies). Ignore them rather than treating them as
  // an Escape keypress or letting their bytes leak into the composer as text.
  return key("ignore");
}

/**
 * Decodes a modified-key escape sequence emitted by an enhanced keyboard protocol:
 *   - kitty keyboard protocol:   CSI codepoint[:alt] [; modifiers[:event]] [; text] u
 *   - xterm modifyOtherKeys:     CSI 27 ; modifiers ; codepoint ~
 * Returns the corresponding key (with ctrl/alt/shift flags) or undefined when the
 * sequence is not a recognized modified key.
 */
function parseModifiedKey(sequence: string): ParsedKey | undefined {
  let codepoint: number | undefined;
  let modifierParam = 1;

  const kitty = sequence.match(/^\u001b\[(\d+)(?::\d+)?(?:;(\d+))?(?::\d+)?(?:;[\d:]+)?u$/);
  if (kitty) {
    codepoint = Number(kitty[1]);
    if (kitty[2]) modifierParam = Number(kitty[2]);
  } else {
    const xterm = sequence.match(/^\u001b\[27;(\d+);(\d+)~$/);
    if (xterm) {
      modifierParam = Number(xterm[1]);
      codepoint = Number(xterm[2]);
    } else {
      const tilde = sequence.match(/^\u001b\[(\d+)(?:;(\d+))?~$/);
      if (tilde) {
        codepoint = Number(tilde[1]);
        if (tilde[2]) modifierParam = Number(tilde[2]);
      }
    }
  }
  if (codepoint === undefined || !Number.isFinite(codepoint)) return undefined;

  const bits = Math.max(0, modifierParam - 1);
  const shift = (bits & 1) !== 0;
  const alt = (bits & 2) !== 0;
  const ctrl = (bits & 4) !== 0;
  return codepointToKey(codepoint, { shift, alt, ctrl });
}

function parseApplicationKey(final: string | undefined): ParsedKey | undefined {
  if (final === "M") return key("return");
  if (final === "A") return key("up");
  if (final === "B") return key("down");
  if (final === "C") return key("right");
  if (final === "D") return key("left");
  if (final === "H") return key("home");
  if (final === "F") return key("end");
  return undefined;
}

function parseCursorKey(sequence: string): ParsedKey | undefined {
  const plain = sequence.match(/^\u001b\[([ABCDHF])$/);
  const modified = sequence.match(/^\u001b\[(?:\d+)?(?:;(\d+))?([ABCDHF])$/);
  const match = plain ?? modified;
  if (!match) return undefined;
  const final = match[plain ? 1 : 2];
  const modifierParam = plain ? 1 : Number(match[1] ?? 1);
  const mods = decodeModifierParam(modifierParam);
  if (final === "A") return key("up", mods);
  if (final === "B") return key("down", mods);
  if (final === "C") return key("right", mods);
  if (final === "D") return key("left", mods);
  if (final === "H") return key("home", mods);
  if (final === "F") return key("end", mods);
  return undefined;
}

function parseNavigationKey(sequence: string): ParsedKey | undefined {
  const match = sequence.match(/^\u001b\[(\d+)(?:;(\d+))?~$/);
  if (!match) return undefined;
  const code = Number(match[1]);
  const mods = decodeModifierParam(Number(match[2] ?? 1));
  if (code === 1 || code === 7) return key("home", mods);
  if (code === 4 || code === 8) return key("end", mods);
  if (code === 3) return key("delete", mods);
  if (code === 5) return key("pageup", mods);
  if (code === 6) return key("pagedown", mods);
  return undefined;
}

function decodeModifierParam(modifierParam: number): { shift: boolean; meta: boolean; ctrl: boolean } {
  const bits = Math.max(0, modifierParam - 1);
  return {
    shift: (bits & 1) !== 0,
    meta: (bits & 2) !== 0,
    ctrl: (bits & 4) !== 0
  };
}

function codepointToKey(codepoint: number, mods: { shift: boolean; alt: boolean; ctrl: boolean }): ParsedKey | undefined {
  const base = { ctrl: mods.ctrl, meta: mods.alt, shift: mods.shift };
  switch (codepoint) {
    case 13: {
      // A CSI-reported Enter only occurs when a modifier is held (plain Enter is "\r"),
      // so treat an otherwise-unmodified report as Shift+Enter.
      const shift = mods.shift || (!mods.alt && !mods.ctrl);
      return { name: "return", ctrl: mods.ctrl, meta: mods.alt, shift };
    }
    case 27: return { name: "escape", ...base };
    case 9: return { name: "tab", ...base };
    case 8:
    case 127: return { name: "backspace", ...base };
  }
  // Ctrl+<letter> shortcuts (e.g. Ctrl+C/O/V) escalated by modifyOtherKeys level 2.
  if (mods.ctrl && codepoint >= 33 && codepoint <= 126) {
    return { name: String.fromCodePoint(codepoint).toLowerCase(), ctrl: true, meta: mods.alt, shift: mods.shift };
  }
  return undefined;
}

function parseControlKey(char: string | undefined): ParsedKey | undefined {
  if (!char) return undefined;
  const code = char.charCodeAt(0);
  if (code < 1 || code > 26) return undefined;
  return key(String.fromCharCode(code + 96), { ctrl: true });
}

function parseSgrMouse(sequence: string): ParsedKey | undefined {
  const match = sequence.match(/^\u001b\[<(\d+);(\d+);(\d+)([mM])$/);
  if (!match) return undefined;
  const button = Number(match[1]);
  const x = Number(match[2]);
  const y = Number(match[3]);
  const final = match[4];
  if (button === 64) return key("wheelup", { mouse: { x, y, button, kind: "wheel" } });
  if (button === 65) return key("wheeldown", { mouse: { x, y, button, kind: "wheel" } });
  const motion = (button & 32) === 32;
  const kind = final === "m" ? "release" : motion && (button & 3) === 3 ? "hover" : motion ? "drag" : "press";
  return key("mouse", { mouse: { x, y, button, kind } });
}

function findStringTerminatorEnd(input: string, start: number): number {
  for (let i = start; i < input.length; i++) {
    if (input[i] === "\u0007") return i + 1;
    if (input[i] === "\u001b" && input[i + 1] === "\\") return i + 2;
  }
  return input.length;
}

function key(name: string, options: Partial<ParsedKey> = {}): ParsedKey {
  return {
    name,
    ctrl: false,
    meta: false,
    shift: false,
    ...options
  };
}

function toKeyEvent(key: ParsedKey, sequence: string): KeyEvent {
  const event: KeyEvent = {
    name: key.name,
    sequence,
    ctrl: key.ctrl,
    meta: key.meta,
    shift: key.shift
  };
  if (key.mouse) event.mouse = key.mouse;
  return event;
}
