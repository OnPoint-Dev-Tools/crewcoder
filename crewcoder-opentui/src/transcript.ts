import type { TuiEventBlock } from "@onpoint-dev-tools/crewcoder-tui-core/state/tui-store";

export type TranscriptTone = "user" | "assistant" | "thinking" | "tool" | "approval" | "error" | "system" | "muted";

export type TranscriptRow = {
  label: string;
  tone: TranscriptTone;
  text: string;
  /** Muted context rendered under the row, such as user-message background. */
  detail?: string;
};

const MAX_TOOL_OUTPUT_LINES = 12;

/**
 * How a block may be written to native scrollback:
 * - `final`: will not change again; commit it whole.
 * - `streaming`: grows by appending text only; finished rows may be committed early.
 * - `live`: still changes in place (running tool, pending approval, ...); keep it
 *   in the footer and commit nothing after it until it becomes final.
 */
export type BlockPhase = "final" | "streaming" | "live";

export function blockPhase(block: TuiEventBlock, isLast: boolean, running: boolean): BlockPhase {
  // Once the run is over nothing can change a block any more, even one the
  // agent never closed (a tool left "running" by a crashed process), so commit
  // everything rather than holding scrollback back forever.
  if (!running) return "final";
  switch (block.type) {
    case "assistant":
    case "thinking":
      // The reducer only appends deltas to the last assistant/thinking block.
      return isLast && running ? "streaming" : "final";
    case "tool":
      return block.status === "running" ? "live" : "final";
    case "approval":
      return block.status === "pending" ? "live" : "final";
    case "extension_ui":
      return block.status === "pending" ? "live" : "final";
    case "compaction":
    case "validation":
    case "background_job":
      return block.status === "running" ? "live" : "final";
    case "crew":
      return block.completed ? "final" : "live";
    case "live_ui":
      return block.status === "loading" || block.status === "ready" ? "live" : "final";
    default:
      return "final";
  }
}

/** Convert a reducer block into a display row. Pure, so it is tested without a renderer. */
export function blockToRow(block: TuiEventBlock): TranscriptRow {
  switch (block.type) {
    case "user":
      return {
        label: "YOU",
        tone: "user",
        text: normalize(block.text),
        // Background is provider context, not typed text; keep it visibly separate.
        detail: block.background?.length ? normalize(block.background.join("\n")) : undefined
      };
    case "assistant":
      return { label: "CREW CODER", tone: "assistant", text: normalize(block.text) };
    case "thinking":
      return { label: "THINKING", tone: "thinking", text: normalize(block.text) };
    case "tool":
      return {
        label: `TOOL ${block.name} · ${block.status}`,
        tone: block.status === "error" ? "error" : "tool",
        text: clampLines(normalize(block.text ?? ""), MAX_TOOL_OUTPUT_LINES)
      };
    case "approval":
      return {
        label: `APPROVAL ${block.toolName ?? ""} · ${block.status}`.replace(/\s+·/, " ·"),
        tone: "approval",
        text: normalize(block.text),
        detail: block.resolutionReason
      };
    case "error":
      return { label: "ERROR", tone: "error", text: normalize(block.text) };
    case "system":
      return { label: "SYSTEM", tone: "system", text: normalize(block.text) };
    case "compaction":
      return { label: `COMPACTION · ${block.status}`, tone: "system", text: normalize(block.message) };
    case "image":
      return { label: "IMAGE", tone: "muted", text: block.attachment.path };
    default:
      // Structured blocks (goals, crews, live UI, ...) are not ported yet. Show
      // that something happened rather than silently dropping the event.
      return { label: block.type.toUpperCase().replace(/_/g, " "), tone: "muted", text: "(not rendered in the OpenTUI preview yet)" };
  }
}

/** Normalize line endings and strip terminal control sequences from agent text. */
export function normalize(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

function clampLines(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return [...lines.slice(0, maxLines), `… ${lines.length - maxLines} more lines`].join("\n");
}
