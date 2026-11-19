import { describeAttachment } from "@onpoint-dev-tools/crewcoder-tui-core/state/image-attachment";
import type { TuiEventBlock } from "@onpoint-dev-tools/crewcoder-tui-core/state/tui-store";

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
    if (last?.kind === "work") last.blocks.push(block);
    else sections.push({ kind: "work", blocks: [block], start: index });
  });
  return sections;
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
      // Pixels (terminal graphics) are not drawn yet; the row names the file and its size.
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
