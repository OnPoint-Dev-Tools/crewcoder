import { describeAttachment } from "@onpoint-dev-tools/crewcoder-tui-core/state/image-attachment";
import { formatTokensPerSecond } from "@onpoint-dev-tools/crewcoder-tui-core/state/usage";
import type { TuiEventBlock } from "@onpoint-dev-tools/crewcoder-tui-core/state/tui-store";
import type { PanelBlock } from "./block-panels.js";
import { USER_MESSAGE_MARKER } from "./glyphs.js";

export type TranscriptTone = "user" | "assistant" | "thinking" | "tool" | "approval" | "error" | "system" | "muted";

export type TranscriptRow = {
  label: string;
  tone: TranscriptTone;
  text: string;
  /** Muted context rendered under the row, such as user-message background. */
  detail?: string;
};

export type ToolBlock = Extract<TuiEventBlock, { type: "tool" }>;
export type ApprovalBlock = Extract<TuiEventBlock, { type: "approval" }>;
/** Blocks that belong to the agent's work: tool calls and the approvals that gate them. */
export type WorkBlock = ToolBlock | ApprovalBlock;

/**
 * A turn reads as sections in event order: a run of consecutive tool calls and
 * approvals is one `work` section (the Agent work box); every other block is
 * its own section. Blocks are never reordered.
 */
export type TranscriptSection =
  | { kind: "work"; blocks: WorkBlock[]; start: number }
  | { kind: "block"; block: TuiEventBlock; start: number };

export function transcriptSections(blocks: readonly TuiEventBlock[]): TranscriptSection[] {
  const sections: TranscriptSection[] = [];
  blocks.forEach((block, index) => {
    if (block.type !== "tool" && block.type !== "approval") {
      sections.push({ kind: "block", block, start: index });
      return;
    }
    const last = sections.at(-1);
    // One box per worker in a crew: a new worker's tools start a new box.
    if (last?.kind === "work" && workerOf(last.blocks.at(-1)) === workerOf(block)) last.blocks.push(block);
    else sections.push({ kind: "work", blocks: [block], start: index });
  });
  return sections;
}

/** The crew worker that produced a block, if any (`worker` is set by the reducer during crews). */
export function workerOf(block: TuiEventBlock | undefined): string | undefined {
  return block && "worker" in block ? block.worker : undefined;
}

/** Per-tool display state, owned by SessionController. */
export type ToolExpansion = {
  /** Long output or diff shown in full rather than collapsed. */
  isExpanded(block: ToolBlock): boolean;
  toggle(block: ToolBlock): void;
  /** The file diff of an edit is shown (not hidden). */
  isDiffShown(block: ToolBlock): boolean;
  toggleDiff(block: ToolBlock): void;
  /** Real file lines of a finished snippet edit, once read (see `computeLineAnchors`). */
  lineAnchors(block: ToolBlock): ReadonlyMap<string, number> | undefined;
};

/** The last assistant/thinking block of an active run still grows; the reducer only appends to it. */
export function isStreaming(block: TuiEventBlock, isLast: boolean, running: boolean): boolean {
  return running && isLast && (block.type === "assistant" || block.type === "thinking");
}

/** Convert a reducer block into a display row. Pure, so it is tested without a renderer. */
export function blockToRow(block: TuiEventBlock): TranscriptRow {
  switch (block.type) {
    case "user":
      // A crew worker's brief came from the crew, not from the keyboard.
      if (block.worker) {
        return {
          label: `TASK → ${normalize(block.worker)}`,
          tone: "muted",
          text: normalize(block.text),
          detail: block.background?.length ? normalize(block.background.join("\n")) : undefined
        };
      }
      // `UserMessage` draws the label as a marker left of the text, not as a row above it.
      return {
        label: USER_MESSAGE_MARKER,
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
        text: normalize(block.text ?? "")
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
      // Tool-result images are labelled apart so they never read as the user's attachment.
      // The caption; `ImageView` draws the pixels between `text` and `detail`.
      return {
        label: block.attachment.source === "tool" ? "TOOL IMAGE" : "IMAGE",
        tone: "muted",
        text: `${block.attachment.name} · ${describeAttachment(block.attachment)}`,
        detail: block.attachment.path
      };
    case "extension_ui":
      // The question and its outcome only; extension and request ids stay internal.
      return {
        label: `QUESTION · ${block.status}`,
        tone: "approval",
        text: normalize(block.title),
        detail: block.answer !== undefined ? `Answer: ${normalize(block.answer)}` : undefined
      };
    case "live_ui":
      // Live UI is skipped by owner decision and never mounted here; say so rather than drop it.
      return { label: "LIVE UI", tone: "muted", text: `${normalize(block.title)} (extension live UI is not available in this UI)` };
    default: {
      // Crews, goals, jobs, ... draw as panels (`block-panels.ts`); the Transcript routes them
      // before reaching here. The assignment makes a new block type a compile error.
      const panel: PanelBlock = block;
      return { label: panel.type.toUpperCase().replace(/_/g, " "), tone: "muted", text: "" };
    }
  }
}

/**
 * A reply's generation speed beside its label (`42.3 tok/s`), once its
 * `message_end` reported it. The agent times only generation, not tools or
 * approvals inside the call (`GenerationClock`). Streaming, replayed, and
 * synthetic replies have none.
 */
export function throughputLabel(block: TuiEventBlock): string | undefined {
  if (block.type !== "assistant") return undefined;
  const rate = block.tokensPerSecond;
  if (rate === undefined || !Number.isFinite(rate) || rate <= 0) return undefined;
  return `${formatTokensPerSecond(rate)} tok/s`;
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
