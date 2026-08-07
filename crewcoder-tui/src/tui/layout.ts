import { fg, reset, visibleLength } from "./ansi.js";

export function padRight(input: string, width: number): string {
  const length = visibleLength(input);
  if (length >= width) return truncate(input, width);
  return input + " ".repeat(width - length);
}

export function truncate(input: string, width: number): string {
  if (width <= 0) return "";
  if (visibleLength(input) <= width) return input;

  const target = width - 1;
  const tokens = input.match(/\x1b\[[0-9;?]*[A-Za-z]|./gsu) ?? [];
  let output = "";
  let visible = 0;
  let styled = false;

  for (const token of tokens) {
    if (token.startsWith("\x1b[")) {
      output += token;
      styled = true;
      continue;
    }
    if (visible >= target) break;
    output += token;
    visible += 1;
  }

  return `${output}…${styled ? reset() : ""}`;
}

export function horizontalRule(width: number, color: string): string {
  return `${fg(color)}${"─".repeat(Math.max(0, width))}${reset()}`;
}

export function emptyLine(width: number): string {
  return " ".repeat(Math.max(0, width));
}

export function splitLines(text: string): string[] {
  return (text || "").split("\n");
}

export function wrapText(text: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  const wrapped: string[] = [];
  for (const line of splitLines(text)) {
    if (!line) {
      wrapped.push("");
      continue;
    }
    wrapped.push(...wrapLine(line, safeWidth));
  }
  return wrapped;
}

function wrapLine(line: string, width: number): string[] {
  const result: string[] = [];
  let remaining = line;
  while (remaining.length > width) {
    const slice = remaining.slice(0, width + 1);
    const breakAt = Math.max(slice.lastIndexOf(" "), slice.lastIndexOf("\t"));
    const cut = breakAt > Math.floor(width * 0.5) ? breakAt : width;
    result.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  result.push(remaining);
  return result;
}

function containTerminalLine(line: string): string {
  return line
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[(?![0-9;?]*m)[0-9;?]*[A-Za-z]/g, "")
    .replace(/\x1b(?!\[[0-9;?]*m)/g, "")
    .replace(/[\x00-\x1a\x1c-\x1f\x7f]/g, " ");
}

export function box(lines: string[], width: number, color: string): string[] {
  const innerWidth = Math.max(0, width - 2);
  return [
    `${fg(color)}╭${"─".repeat(innerWidth)}╮${reset()}`,
    ...lines.map((line) => {
      // A component line may contain user/provider text. Preserve SGR colors but
      // remove cursor-moving/control sequences that could escape the box.
      const contained = containTerminalLine(line);
      return `${fg(color)}│${reset()}${padRight(contained, innerWidth)}${fg(color)}│${reset()}`;
    }),
    `${fg(color)}╰${"─".repeat(innerWidth)}╯${reset()}`
  ];
}
