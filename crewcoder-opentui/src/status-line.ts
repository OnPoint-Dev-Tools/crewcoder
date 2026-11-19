import type { TuiState } from "@onpoint-dev-tools/crewcoder-tui-core/state/tui-store";
import { formatContextStatus, type TuiUsageSummary } from "@onpoint-dev-tools/crewcoder-tui-core/state/usage";
import stringWidth from "string-width";
import { normalize } from "./transcript.js";

/**
 * The one-row status line under the composer, ported from the legacy UI:
 * approval access, mode (or worker), provider/model (effort), and the
 * session's name on the left; context usage and session cost pinned right.
 */
export type StatusLine = {
  access: "Review" | "Full Access";
  /** Everything after the access label, already truncated to fit. */
  left: string;
  /** Context usage and cost (`◔ 12.4k/200k - 6% | 12.4k tokens | $0.03`); empty until the backend reports usage. */
  right: string;
};

type StatusState = Pick<TuiState, "fullAccess" | "mode" | "worker" | "workerIdentityEnabled" | "provider" | "model" | "effort" | "usage" | "gitRepo" | "blocks">;

const SEPARATOR = " · ";
const ELLIPSIS = "…";
/** Minimum cells between the left side and the usage. */
const GAP = 2;

export function statusLine(state: StatusState, width: number): StatusLine {
  const access = state.fullAccess ? "Full Access" : "Review";
  // Same rule as the legacy composer: a worker shows only while identity is on.
  const mode = state.workerIdentityEnabled && state.worker ? `worker ${state.worker}` : state.mode;
  // The session's name is last, so it is the first thing to shorten.
  const details = [mode, `${state.provider}/${state.model} (${state.effort})`, sessionName(state)].join(SEPARATOR);
  // Access is a safety state, so it always shows. Usage takes what is left
  // after it (with a two-cell gap); the details give way first.
  const right = clip(usageStatus(state.usage), width - cells(access) - GAP);
  const leftRoom = width - cells(access) - (right ? cells(right) + GAP : 0) - cells(SEPARATOR);
  const shown = clip(details, leftRoom);
  return { access, left: shown ? `${SEPARATOR}${shown}` : "", right };
}

/**
 * What the session is about instead of its raw id: `<repo> · <chat name>`.
 * The chat name is the first prompt, the same label `/sessions` lists it by
 * (sessions have no separate title). Either part shows alone when the other is
 * missing; `new session` before any prompt outside a repo.
 */
export function sessionName(state: Pick<TuiState, "gitRepo" | "blocks">): string {
  const first = state.blocks.find((block) => block.type === "user");
  const chat = first?.type === "user" ? normalize(first.text).replace(/\s+/g, " ").trim() : "";
  return [state.gitRepo, chat].filter(Boolean).join(SEPARATOR) || "new session";
}

/** Context usage and cost, or nothing before the first usage report (no `?/?` placeholder). */
export function usageStatus(usage: TuiUsageSummary): string {
  // Token counts, not cost alone: formatContextStatus would print `?/?` placeholders without them.
  const known = [usage.lastInputTokens, usage.totalTokens, usage.inputTokens].some((value) => typeof value === "number");
  const budget = typeof usage.tokenBudget === "number" && usage.tokenBudget > 0;
  return known || budget ? formatContextStatus(usage) : "";
}

/** The context gauge glyph (`○ ◔ ◑ ◕ ●`) at the start of the usage text, if any, so it can be colored. */
export function splitGauge(right: string): { gauge: string; rest: string } {
  const first = [...right][0];
  return first && GAUGE_GLYPHS.has(first) ? { gauge: first, rest: right.slice(first.length) } : { gauge: "", rest: right };
}

const GAUGE_GLYPHS: ReadonlySet<string> = new Set(["○", "◔", "◑", "◕", "●"]);

/** Cut `text` to at most `room` terminal cells, ending in `…` when cut. Wide characters (emoji, CJK) count as two. */
function clip(text: string, room: number): string {
  if (room <= 0) return "";
  if (cells(text) <= room) return text;
  const budget = room - cells(ELLIPSIS);
  let out = "";
  let used = 0;
  for (const { segment } of GRAPHEMES.segment(text)) {
    const width = cells(segment);
    if (used + width > budget) break;
    out += segment;
    used += width;
  }
  return `${out}${ELLIPSIS}`;
}

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Terminal cells, so chat names with emoji or CJK never overflow the row. */
function cells(text: string): number {
  return stringWidth(text);
}
