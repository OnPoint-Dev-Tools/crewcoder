import type { TuiEventBlock } from "@onpoint-dev-tools/crewcoder-tui-core/state/tui-store";
import { toolApprovalHeight } from "./components/ui/tool-approval.js";

type ApprovalBlock = Extract<TuiEventBlock, { type: "approval" }>;
type ToolBlock = Extract<TuiEventBlock, { type: "tool" }>;
type StreamingBlock = Extract<TuiEventBlock, { type: "assistant" | "thinking" }>;

export const MAX_FOOTER_TOOLS = 3;
export const MAX_FOOTER_OTHER = 2;
export const COMPOSER_ROWS = 3;
export const STATUS_ROWS = 1;
/**
 * Rows every conversation footer keeps: the streaming-tail row and the
 * working/hints row. Reserving them keeps the footer the same height whether a
 * turn is running or idle, because OpenTUI shrinks a split footer by keeping
 * its top row, which would leave blank rows under the status line.
 */
export const RESERVED_ROWS = 2;

/** What the split footer shows for the blocks not yet in scrollback. */
export type FooterModel = {
  approval?: ApprovalBlock;
  tools: ToolBlock[];
  hiddenTools: number;
  streaming?: StreamingBlock;
  other: TuiEventBlock[];
  working: boolean;
  rows: number;
};

export function footerModel(pending: readonly TuiEventBlock[], running: boolean): FooterModel {
  const approval = pending.find((block): block is ApprovalBlock => block.type === "approval" && block.status === "pending");
  const runningTools = pending.filter((block): block is ToolBlock => block.type === "tool" && block.status === "running");
  const tools = runningTools.slice(0, MAX_FOOTER_TOOLS);
  const hiddenTools = runningTools.length - tools.length;
  const last = pending.at(-1);
  const streaming = running && (last?.type === "assistant" || last?.type === "thinking") ? last : undefined;
  const other = pending
    .filter((block) => block !== approval && block !== streaming && !runningTools.includes(block as ToolBlock))
    .slice(0, MAX_FOOTER_OTHER);
  const rows =
    (approval ? toolApprovalHeight({ description: approval.text, args: approval.args }) : 0) +
    tools.length + (hiddenTools > 0 ? 1 : 0) +
    other.length +
    RESERVED_ROWS +
    COMPOSER_ROWS +
    STATUS_ROWS;
  return { approval, tools, hiddenTools, streaming, other, working: running, rows };
}

/**
 * The centered welcome screen shows while the session is empty and idle; the
 * footer then fills the terminal. Any block (even an error from an unported
 * command) ends it, so nothing written to scrollback is hidden behind it.
 */
export function isHome(blocks: readonly TuiEventBlock[], running: boolean): boolean {
  return !running && blocks.length === 0;
}

/**
 * Footer height: the welcome screen fills the terminal; in a conversation the
 * footer is just its content (live region, composer, status), pinned to the
 * bottom by the writer's leading padding.
 */
export function footerHeight(options: { home: boolean; contentRows: number; terminalHeight: number }): number {
  return options.home ? Math.max(options.contentRows, options.terminalHeight) : options.contentRows;
}

export const HOME_COMPOSER_MIN_WIDTH = 24;

/** Composer width on the home screen: 62% of the terminal, like the legacy landing page. */
export function homeComposerWidth(width: number): number {
  // Clamp last so a terminal narrower than the floor never gets a wider composer.
  return Math.min(width, Math.max(HOME_COMPOSER_MIN_WIDTH, Math.floor(width * 0.62)));
}

/** Rows the welcome screen needs below the logo: gap, composer (3), hint, gap, tip, info. */
export const HOME_BODY_ROWS = 8;

/**
 * The big block wordmark, or nothing. Smaller logo variants are not used: when
 * the wordmark does not fit (narrower than 70 columns, or too short to keep the
 * composer whole), the welcome screen shows only the composer.
 */
export function homeLogo(width: number, height: number, logo: readonly string[]): readonly string[] | undefined {
  const logoWidth = Math.max(0, ...logo.map((line) => line.length));
  const fits = width >= Math.max(70, logoWidth + 2) && height >= logo.length + HOME_BODY_ROWS + 2;
  return fits ? logo : undefined;
}

/**
 * Fit a path into `max` columns: abbreviate the local home directory as `~`
 * (pass no home for remote paths), then keep the end, which names the project.
 */
export function shortenPath(path: string, max: number, home?: string): string {
  const local = home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;
  if (local.length <= max) return local;
  return max <= 1 ? "…" : `…${local.slice(local.length - max + 1)}`;
}

/** The end of the last logical line, which always contains the not-yet-committed row. */
export function streamingTail(text: string, width: number): string {
  const tail = text.slice(text.lastIndexOf("\n") + 1);
  const room = Math.max(1, width - 1);
  return tail.length > room ? `…${tail.slice(tail.length - room + 1)}` : tail;
}
