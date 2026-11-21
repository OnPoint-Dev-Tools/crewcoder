import type { TuiEventBlock } from "@onpoint-dev-tools/crewcoder-tui-core/state/tui-store";

/**
 * Prompt history recall, ported from the legacy composer
 * (`crewcoder-tui/src/components/Composer.ts` `recallHistory`).
 *
 * History is this session's user messages, read from the transcript, so it is
 * session-scoped for free and a resumed session recalls its own messages.
 * Each Up loads the next older message; Down walks back toward newer ones and
 * finally restores the draft that was in the composer before the first Up.
 */
export type HistoryRecall = {
  /** Position in `sentMessages` (0 = newest) of the recalled message; unset when not recalling. */
  index?: number;
  /** Composer text before the first Up, restored by Down past the newest message. */
  draft: string;
  /** The text last put in the composer, to notice the user editing it. */
  recalled?: string;
};

export const IDLE_RECALL: HistoryRecall = { draft: "" };

/** This session's user messages, newest first, without blanks or back-to-back repeats. */
export function sentMessages(blocks: readonly TuiEventBlock[]): string[] {
  const messages: string[] = [];
  for (const block of blocks) {
    // Crew workers' briefs were never typed; the `/crew` or `/team` command that started them was.
    if (block.type !== "user" || block.worker) continue;
    const text = block.text.trim();
    // Repeats of the next message are skipped so every Up shows different text.
    if (text && text !== messages[0]) messages.unshift(text);
  }
  return messages;
}

/**
 * One Up or Down step. Returns the next recall state and the text to put in
 * the composer, or `undefined` when there is nothing to recall in that
 * direction (the key then does nothing). Editing a recalled message abandons
 * the recall, so the next Up starts again from the newest message.
 */
export function stepRecall(
  recall: HistoryRecall,
  direction: "up" | "down",
  current: string,
  messages: readonly string[]
): { recall: HistoryRecall; text: string } | undefined {
  const active = recall.index !== undefined && current === recall.recalled ? recall : IDLE_RECALL;
  if (direction === "up") {
    const older = active.index === undefined ? 0 : active.index + 1;
    const text = messages[older];
    if (text === undefined) return undefined;
    const draft = active.index === undefined ? current : active.draft;
    return { recall: { index: older, draft, recalled: text }, text };
  }
  if (active.index === undefined) return undefined;
  if (active.index === 0) return { recall: IDLE_RECALL, text: active.draft };
  const newer = active.index - 1;
  const text = messages[newer]!;
  return { recall: { index: newer, draft: active.draft, recalled: text }, text };
}
