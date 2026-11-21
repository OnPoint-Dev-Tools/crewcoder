import type { TuiEventBlock } from "@onpoint-dev-tools/crewcoder-tui-core/state/tui-store";
import stringWidth from "string-width";
import { blockPanel, isPanelBlock } from "./block-panels.js";
import { toolDiffs, type LineAnchors } from "./tool-diff.js";
import { COLLAPSED_OUTPUT_LINES, toolPresentation } from "./tool-presentation.js";
import { blockToRow, normalize, type ToolBlock } from "./transcript.js";
import { workflowTexts, workflowView } from "./workflow-tools.js";
import { renderedTool } from "./tool-renderer-view.js";
import { findToolRenderer } from "@onpoint-dev-tools/crewcoder-tui-core/state/tool-renderers";
import type { TuiRendererHook } from "@onpoint-dev-tools/crewcoder-tui-core/state/tui-store";

/**
 * Transcript search (`docs/TRANSCRIPT.md#search`): which blocks match a query,
 * in event order. Pure, so it is tested without a renderer. It searches the
 * text each block draws, not labels such as `CREW CODER`, and covers what a
 * collapse hides (tool output past `COLLAPSED_OUTPUT_LINES`, hidden diffs) so a
 * jump can reveal it first.
 */

/** Where in a block the text sits: `output` and `diff` may be collapsed or hidden. */
export type SearchPartKind = "text" | "output" | "diff";

export type SearchPart = { kind: SearchPartKind; text: string };

export type SearchMatch = {
  /** Index into `state.blocks`. */
  block: number;
  /** Which occurrence in that block, in drawn order (0 = first). */
  ordinal: number;
  kind: SearchPartKind;
  /** Line index within its part (output lines decide whether a collapse hides it). */
  line: number;
  /** The whole line the match is on, and the match's [start, end) in it. */
  text: string;
  start: number;
  end: number;
};

/** More than this many matches show as `999+`; the search stops collecting there. */
export const MAX_SEARCH_MATCHES = 999;

/** Smart case: a query with a capital letter matches case; otherwise case is ignored. */
export function caseSensitive(query: string): boolean {
  return /\p{Lu}/u.test(query);
}

/** Every [start, end) of `query` in `text` under the smart-case rule; empty for an empty query. */
export function occurrences(text: string, query: string): Array<[number, number]> {
  if (!query) return [];
  const sensitive = caseSensitive(query);
  const haystack = sensitive ? text : text.toLowerCase();
  const needle = sensitive ? query : query.toLowerCase();
  // Lowercasing can change length (e.g. "İ"); fall back to the original text then.
  if (haystack.length !== text.length) return exactOccurrences(text, query);
  return exactOccurrences(haystack, needle);
}

function exactOccurrences(text: string, query: string): Array<[number, number]> {
  const found: Array<[number, number]> = [];
  for (let index = text.indexOf(query); index !== -1; index = text.indexOf(query, index + query.length)) {
    found.push([index, index + query.length]);
  }
  return found;
}

/** The searchable text of one block, in the order the transcript draws it. */
export function searchableParts(block: TuiEventBlock, cwd: string, anchors?: LineAnchors, renderers: readonly TuiRendererHook[] = []): SearchPart[] {
  if (block.type === "tool") return toolParts(block, cwd, anchors, renderers);
  if (block.type === "approval") {
    const status = block.status === "pending" ? "waiting for approval" : block.status;
    return parts([`Approval · ${block.toolName ?? "tool"} · ${status}`, block.resolutionReason ? normalize(block.resolutionReason) : undefined]);
  }
  if (isPanelBlock(block)) {
    const panel = blockPanel(block);
    return parts([panel.meta ? `${panel.title}  ${panel.meta}` : panel.title, ...panel.lines.map((line) => line.text)]);
  }
  const row = blockToRow(block);
  return parts([row.text, row.detail]);
}

function parts(texts: ReadonlyArray<string | undefined>): SearchPart[] {
  return texts.filter((text): text is string => Boolean(text)).map((text) => ({ kind: "text", text }));
}

/** Title row (title, target, status), then the output or the edit's diff lines. */
function toolParts(block: ToolBlock, cwd: string, anchors: LineAnchors | undefined, renderers: readonly TuiRendererHook[]): SearchPart[] {
  const tool = toolPresentation(block, cwd, "text");
  const status = block.status === "running" ? "running…" : tool.failed ? "failed" : undefined;
  // An extension renderer replaces the whole view: its title, source, and filled-in template.
  const renderer = findToolRenderer(block, renderers);
  if (renderer) {
    const view = renderedTool(block, renderer);
    return parts([[view.title, view.source, status].filter(Boolean).join(" "), view.body]);
  }
  const workflow = workflowView(block);
  // A plan or clarify step shows its arguments, never collapsed, instead of a target and output.
  if (workflow) {
    const header = [workflow.title, status].filter(Boolean).join(" ");
    return [header, ...workflowTexts(workflow)].map((text): SearchPart => ({ kind: "text", text }));
  }
  const header = [tool.title || block.name, tool.layout === "inline" ? tool.target : undefined, status].filter(Boolean).join(" ");
  const result: SearchPart[] = [{ kind: "text", text: header }];
  if (tool.layout === "stacked" && tool.target) result.push({ kind: "text", text: tool.target });
  const diffs = toolDiffs(block, cwd, anchors);
  if (diffs.length === 0) {
    if (tool.output) result.push({ kind: "output", text: tool.output });
    return result;
  }
  // `<diff>` draws +/- in its gutter, so exact diffs search the line without its sign.
  const body = diffs.flatMap((diff) => (diff.exactLines ? diff.body.map(stripSign) : diff.body));
  if (body.length > 0) result.push({ kind: "diff", text: body.join("\n") });
  return result;
}

function stripSign(line: string): string {
  return /^[+\- ]/.test(line) ? line.slice(1) : line;
}

/** Every match of `query` across the transcript, oldest first, capped at `MAX_SEARCH_MATCHES`. */
export function findMatches(
  blocks: readonly TuiEventBlock[],
  query: string,
  cwd: string,
  anchors?: (block: ToolBlock) => LineAnchors | undefined,
  renderers: readonly TuiRendererHook[] = []
): SearchMatch[] {
  const matches: SearchMatch[] = [];
  if (!query) return matches;
  for (const [index, block] of blocks.entries()) {
    let ordinal = 0;
    for (const part of searchableParts(block, cwd, block.type === "tool" ? anchors?.(block) : undefined, renderers)) {
      for (const [line, text] of part.text.split("\n").entries()) {
        for (const [start, end] of occurrences(text, query)) {
          matches.push({ block: index, ordinal, kind: part.kind, line, text, start, end });
          ordinal += 1;
          if (matches.length >= MAX_SEARCH_MATCHES) return matches;
        }
      }
    }
  }
  return matches;
}

/** `3/12`, `0/0`, or `1/999+` at the cap. */
export function matchCounter(index: number | undefined, total: number): string {
  const count = total >= MAX_SEARCH_MATCHES ? `${MAX_SEARCH_MATCHES}+` : String(total);
  return `${index === undefined ? 0 : index + 1}/${count}`;
}

/** Whether a tool must expand (or show its diff) for this match to be drawn. */
export function revealNeeded(match: SearchMatch): { expand: boolean; showDiff: boolean } {
  if (match.kind === "output") return { expand: match.line >= COLLAPSED_OUTPUT_LINES, showDiff: false };
  if (match.kind === "diff") return { expand: match.line >= COLLAPSED_OUTPUT_LINES, showDiff: true };
  return { expand: false, showDiff: false };
}

/** The match line cut to `width` cells around the match: `before`, `match`, `after`, with `…` where cut. */
export function matchSnippet(match: Pick<SearchMatch, "text" | "start" | "end">, width: number): { before: string; match: string; after: string } {
  const line = match.text.replace(/\t/g, " ");
  let before = line.slice(0, match.start).trimStart();
  let hit = line.slice(match.start, match.end);
  let after = line.slice(match.end).trimEnd();
  const room = Math.max(1, width);
  // A line that fits is shown whole.
  if (stringWidth(before + hit + after) <= room) return { before, match: hit, after };
  hit = fitEnd(hit, room);
  // Context on the left gets up to a third of what is left; the rest goes to the right.
  const left = Math.floor((room - stringWidth(hit)) / 3);
  if (stringWidth(before) > left) before = left > 1 ? `…${fitStart(before, left - 1)}` : "";
  const right = room - stringWidth(before) - stringWidth(hit);
  if (stringWidth(after) > right) after = right > 1 ? `${fitEnd(after, right - 1)}…` : "";
  return { before, match: hit, after };
}

/** The longest start of `text` that fits `width` cells. */
function fitEnd(text: string, width: number): string {
  let result = "";
  for (const char of text) {
    if (stringWidth(result + char) > width) break;
    result += char;
  }
  return result;
}

/** The longest end of `text` that fits `width` cells. */
function fitStart(text: string, width: number): string {
  let result = "";
  for (const char of Array.from(text).reverse()) {
    if (stringWidth(char + result) > width) break;
    result = char + result;
  }
  return result;
}
