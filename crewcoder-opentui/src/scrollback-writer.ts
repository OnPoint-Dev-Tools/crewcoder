import { BoxRenderable, TextRenderable, bold, fg, t, type ScrollbackSurface } from "@opentui/core";
import type { TuiEventBlock } from "@onpoint-dev-tools/crewcoder-tui-core/state/tui-store";
import type { Theme } from "./components/ui/types.js";
import { bodyColor, toneColor } from "./theme.js";
import { blockPhase, blockToRow } from "./transcript.js";

/** The renderer surface the writer needs; satisfied by a split-footer `CliRenderer`. */
export type ScrollbackHost = {
  createScrollbackSurface(options?: { startOnNewLine?: boolean }): ScrollbackSurface;
};

type ActiveBlock = {
  block: TuiEventBlock;
  surface: ScrollbackSurface;
  body: TextRenderable;
  text: string;
  committedRows: number;
};

export type ScrollbackSource = {
  readonly state: { readonly blocks: readonly TuiEventBlock[]; readonly running: boolean };
  subscribe(listener: () => void): () => void;
};

/** Keeps the split footer sized; see attachScrollback. */
export type FooterControl = {
  /** Before writing: only the welcome-screen to conversation transition (see prepareFooterForWrites). */
  prepare(): void;
  /** After writing: set the footer height for the current state. */
  size(): void;
  /** Whether the renderer has applied the requested height yet. */
  settled(): boolean;
};

const RETRY_MS = 16;

/**
 * Sync the writer on every state change. Attach before mounting the footer so
 * `writer.pending` is current whenever React renders.
 *
 * Leaving the welcome screen, the footer is shrunk before writing, and nothing
 * is written until the renderer has applied that size. OpenTUI defers a resize requested mid-render, and
 * defers it again while commits are queued; a shrinking footer also keeps its
 * top row. Writing before the resize applied made the first message (leaving
 * the full-height welcome screen) commit with no room above the footer, so it
 * scrolled straight into history and the composer floated mid-screen. The
 * footer is sized again after writing to pick up the exact live content.
 */
export function attachScrollback(source: ScrollbackSource, writer: ScrollbackWriter, footer?: FooterControl): () => void {
  let retry: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const sync = (): void => {
    if (stopped) return;
    if (retry !== undefined) clearTimeout(retry);
    retry = undefined;
    footer?.prepare();
    if (footer && !footer.settled()) {
      retry = setTimeout(sync, RETRY_MS);
      return;
    }
    writer.sync(source.state.blocks, source.state.running);
    footer?.size();
  };
  sync();
  const unsubscribe = source.subscribe(sync);
  return () => {
    stopped = true;
    if (retry !== undefined) clearTimeout(retry);
    unsubscribe();
  };
}

/** Upper bound on cells per commit; OpenTUI rejects commits above ~349k cells. */
const MAX_COMMIT_CELLS = 200_000;

/**
 * Writes settled transcript blocks into the terminal's native scrollback above
 * the split footer, in order, exactly once.
 *
 * Blocks are tracked by identity rather than index because the reducer trims
 * `state.blocks` to its last 500 entries. A streaming assistant/thinking block
 * commits every finished row as text arrives and keeps only its last, still
 * changing row back. The first `live` block (running tool, pending approval,
 * ...) stops the writer so scrollback never goes out of order; it and every
 * later block are returned as pending for the footer to show.
 */
export class ScrollbackWriter {
  private readonly host: ScrollbackHost;
  private readonly theme: Theme;
  private readonly leadingRows: () => number;
  private readonly committed = new WeakSet<TuiEventBlock>();
  private active: ActiveBlock | undefined;
  private wroteBlock = false;
  private pendingBlocks: readonly TuiEventBlock[] = [];

  constructor(host: ScrollbackHost, theme: Theme, leadingRows: () => number = () => 0) {
    this.host = host;
    this.theme = theme;
    this.leadingRows = leadingRows;
  }

  /** Blocks not fully in scrollback yet, in transcript order. */
  get pending(): readonly TuiEventBlock[] {
    return this.pendingBlocks;
  }

  sync(blocks: readonly TuiEventBlock[], running: boolean): readonly TuiEventBlock[] {
    if (this.active && !blocks.includes(this.active.block)) this.dropActive();
    if (blocks.length === 0) this.wroteBlock = false;
    const pending: TuiEventBlock[] = [];
    let held = false;
    blocks.forEach((block, index) => {
      if (this.committed.has(block)) return;
      if (held) {
        pending.push(block);
        return;
      }
      const phase = blockPhase(block, index === blocks.length - 1, running);
      if (phase === "final") {
        this.writeFinal(block);
        return;
      }
      if (phase === "streaming") this.stream(block);
      pending.push(block);
      held = true;
    });
    this.pendingBlocks = pending;
    return pending;
  }

  dispose(): void {
    this.dropActive();
  }

  private writeFinal(block: TuiEventBlock): void {
    const active = this.active?.block === block ? this.active : this.open(block);
    this.active = undefined;
    try {
      this.update(active);
      this.commitThrough(active, active.surface.height, true);
    } finally {
      active.surface.destroy();
    }
    this.committed.add(block);
  }

  private stream(block: TuiEventBlock): void {
    if (!this.active) this.active = this.open(block);
    const active = this.active;
    this.update(active);
    // The last row can still grow or rewrap as text arrives; hold it back.
    this.commitThrough(active, active.surface.height - 1);
  }

  private open(block: TuiEventBlock): ActiveBlock {
    this.writeBlankRows(this.wroteBlock ? 1 : this.leadingRows());
    this.wroteBlock = true;
    const row = blockToRow(block);
    const surface = this.host.createScrollbackSurface({ startOnNewLine: true });
    try {
      const column = new BoxRenderable(surface.renderContext, { flexDirection: "column", width: "100%" });
      column.add(new TextRenderable(surface.renderContext, {
        content: t`${bold(fg(toneColor(this.theme, row.tone))(row.label))}`,
        width: "100%",
        wrapMode: "word"
      }));
      const body = new TextRenderable(surface.renderContext, {
        content: "",
        width: "100%",
        wrapMode: "word",
        fg: bodyColor(this.theme, row.tone)
      });
      column.add(body);
      if (row.detail) {
        column.add(new TextRenderable(surface.renderContext, {
          content: row.detail,
          width: "100%",
          wrapMode: "word",
          fg: this.theme.colors.mutedForeground
        }));
      }
      surface.root.add(column);
      return { block, surface, body, text: "", committedRows: 0 };
    } catch (error) {
      surface.destroy();
      throw error;
    }
  }

  private update(active: ActiveBlock): void {
    const text = blockToRow(active.block).text;
    if (text !== active.text) {
      active.body.content = text;
      active.text = text;
    }
    active.surface.render();
  }

  /**
   * `final` ends the block's last commit with a newline. Without it OpenTUI's
   * scrollback cursor stays at the end of the last text row, and the split
   * footer, which sits just below that cursor, rises one row off the bottom
   * whenever a turn finishes.
   */
  private commitThrough(active: ActiveBlock, endRow: number, final = false): void {
    const chunk = Math.max(1, Math.floor(MAX_COMMIT_CELLS / Math.max(1, active.surface.width)));
    if (final && active.committedRows >= endRow) {
      // Everything was streamed already; still end the block on a new line.
      active.surface.commitRows(endRow, endRow, { trailingNewline: true });
      return;
    }
    while (active.committedRows < endRow) {
      const next = Math.min(endRow, active.committedRows + chunk);
      active.surface.commitRows(active.committedRows, next, final && next === endRow ? { trailingNewline: true } : undefined);
      active.committedRows = next;
    }
  }

  private writeBlankRows(count: number): void {
    const rows = Math.max(0, Math.floor(count));
    if (rows === 0) return;
    const surface = this.host.createScrollbackSurface({ startOnNewLine: true });
    try {
      surface.root.add(new TextRenderable(surface.renderContext, { content: "", width: "100%", height: rows }));
      surface.render();
      surface.commitRows(0, Math.max(rows, surface.height));
    } finally {
      surface.destroy();
    }
  }

  private dropActive(): void {
    this.active?.surface.destroy();
    this.active = undefined;
  }
}
