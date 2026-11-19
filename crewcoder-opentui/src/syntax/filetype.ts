import { pathToFiletype } from "@opentui/core";
import { highlightedFiletypes } from "./grammars.js";

/**
 * The Tree-sitter filetype for a file path, or undefined when no bundled or
 * OpenTUI parser covers it. Undefined means plain text: unknown languages
 * never reach the worker.
 */
export function codeFiletype(path: string | undefined, supported: ReadonlySet<string> = highlightedFiletypes()): string | undefined {
  if (!path) return undefined;
  const filetype = pathToFiletype(path);
  return filetype && supported.has(filetype) ? filetype : undefined;
}

/** `     1→code` (Claude Code's Read) or `1\tcode` (`cat -n`). */
const NUMBERED_LINE = /^\s*\d+(?:→|\t)/;
const SAMPLE_LINES = 5;

/**
 * The filetype for a read tool's output. Output whose lines carry line-number
 * prefixes is not source code to a parser, so it stays plain.
 */
export function readOutputFiletype(path: string | undefined, output: string, supported?: ReadonlySet<string>): string | undefined {
  const filetype = codeFiletype(path, supported);
  if (!filetype) return undefined;
  const sample = output.split("\n").filter((line) => line.trim() !== "").slice(0, SAMPLE_LINES);
  return sample.length > 0 && sample.every((line) => NUMBERED_LINE.test(line)) ? undefined : filetype;
}
