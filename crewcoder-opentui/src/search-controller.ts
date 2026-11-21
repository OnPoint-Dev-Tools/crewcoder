import type { TuiState } from "@onpoint-dev-tools/crewcoder-tui-core/state/tui-store";
import type { ToolExpansion } from "./transcript.js";
import { findMatches, revealNeeded, type SearchMatch } from "./transcript-search.js";

/** What transcript search needs from `SessionController`. */
export type SearchHost = {
  readonly state: TuiState;
  /** Expansion state to reveal a hidden match; its line anchors keep diff lines as drawn. */
  readonly toolExpansion: ToolExpansion;
  changed(): void;
};

/**
 * Transcript search state (`docs/TRANSCRIPT.md#search`): the query, its
 * matches, and the current one. Matching is the pure `transcript-search.ts`;
 * App scrolls to `current` and marks its line whenever `jumpVersion` changes.
 * Search starts at the newest match, since the transcript sits at the bottom.
 */
export class TranscriptSearch {
  private readonly host: SearchHost;
  isOpen = false;
  query = "";
  matches: SearchMatch[] = [];
  /** Index into `matches`; undefined when nothing matches. */
  index: number | undefined;
  /** Bumped on every jump, so App scrolls again even to the same match. */
  jumpVersion = 0;

  constructor(host: SearchHost) {
    this.host = host;
  }

  get current(): SearchMatch | undefined {
    return this.index === undefined ? undefined : this.matches[this.index];
  }

  open(query = ""): void {
    this.isOpen = true;
    this.setQuery(query);
  }

  /** Close the bar; the transcript stays where the last match left it. */
  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.query = "";
    this.matches = [];
    this.index = undefined;
    this.host.changed();
  }

  /** A new query: jump to its newest match. */
  setQuery(query: string): void {
    this.query = query;
    this.matches = this.find();
    this.index = this.matches.length > 0 ? this.matches.length - 1 : undefined;
    this.jump();
  }

  /** Enter / Up: the previous (older) match, wrapping to the newest. */
  older(): void {
    this.step(-1);
  }

  /** Shift+Enter / Down: the next (newer) match, wrapping to the oldest. */
  newer(): void {
    this.step(1);
  }

  /**
   * Re-run the search first: the transcript may have grown since the last key.
   * The step counts from the current match's new position.
   */
  private step(delta: number): void {
    const previous = this.current;
    this.matches = this.find();
    const count = this.matches.length;
    if (count === 0) {
      this.index = undefined;
      return this.jump();
    }
    const at = previous ? this.matches.findIndex((match) => match.block === previous.block && match.ordinal === previous.ordinal) : -1;
    const from = at === -1 ? (delta < 0 ? count : -1) : at;
    this.index = (((from + delta) % count) + count) % count;
    this.jump();
  }

  private find(): SearchMatch[] {
    return findMatches(this.host.state.blocks, this.query, this.host.state.cwd, (block) => this.host.toolExpansion.lineAnchors(block));
  }

  /** Make the current match drawable (expand collapsed output, show a hidden diff), then ask App to scroll. */
  private jump(): void {
    const match = this.current;
    const block = match ? this.host.state.blocks[match.block] : undefined;
    if (match && block?.type === "tool") {
      const { expand, showDiff } = revealNeeded(match);
      const expansion = this.host.toolExpansion;
      if (expand && !expansion.isExpanded(block)) expansion.toggle(block);
      if (showDiff && !expansion.isDiffShown(block)) expansion.toggleDiff(block);
    }
    this.jumpVersion += 1;
    this.host.changed();
  }
}
