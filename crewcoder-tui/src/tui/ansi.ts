export const clearScreen = () => "\x1b[2J\x1b[H";
export const hideCursor = () => "\x1b[?25l";
export const showCursor = () => "\x1b[?25h";
export const enableMouse = () => "\x1b[?1000h\x1b[?1003h\x1b[?1006h";
export const disableMouse = () => "\x1b[?1006l\x1b[?1003l\x1b[?1000l";
// Focus reports (CSI I / CSI O) let each TUI reject input delivered to an
// unfocused terminal surface. This is process-local input isolation for tabs,
// panes, and windows, including terminals that route keys too broadly.
export const enableFocusReporting = () => "\x1b[?1004h";
export const disableFocusReporting = () => "\x1b[?1004l";
export const setTerminalBackground = (hex: string) => `\x1b]11;${hex}\x07`;
export const resetTerminalBackground = () => "\x1b]111\x07";
// Ask the terminal to report modified keys (e.g. Shift+Enter) as distinct escape
// sequences. Enables the kitty keyboard protocol (disambiguate flag) for
// kitty/ghostty and xterm's modifyOtherKeys level 2 for xterm; each terminal
// honors whichever it supports and ignores the other. Level 2 escalates modified
// special keys (Enter, Tab, Ctrl+letter) while leaving normal text untouched, so
// the parser decodes those sequences back into key events.
export const enableKeyboardProtocol = () => "\x1b[>1u\x1b[>4;2m";
export const disableKeyboardProtocol = () => "\x1b[>4;0m\x1b[<u";
export const moveTo = (row: number, col: number) => `\x1b[${row};${col}H`;
export const reset = () => "\x1b[0m";
export const bold = () => "\x1b[1m";
export const dim = () => "\x1b[2m";
export const italic = () => "\x1b[3m";
export const strikethrough = () => "\x1b[9m";

export function fg(hex: string): string {
  const { r, g, b } = parseHex(hex);
  return `\x1b[38;2;${r};${g};${b}m`;
}

export function bg(hex: string): string {
  const { r, g, b } = parseHex(hex);
  return `\x1b[48;2;${r};${g};${b}m`;
}

function parseHex(hex: string): { r: number; g: number; b: number } {
  const normalized = hex.replace("#", "");
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16)
  };
}

export function stripAnsi(input: string): string {
  return input.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

export function visibleLength(input: string): number {
  return stripAnsi(input).length;
}
