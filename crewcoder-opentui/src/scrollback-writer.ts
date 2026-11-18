import { TextRenderable, type ScrollbackSurface } from "@opentui/core";
import type { TuiEventBlock } from "@onpoint-dev-tools/crewcoder-tui-core/state/tui-store";
import type { Theme } from "./components/ui/types.js";
import { createBlockView, type BlockView } from "./scrollback-blocks.js";
import { blockPhase } from "./transcript.js";

/** The renderer surface the writer needs; satisfied by a split-footer `CliRenderer`. */
export type ScrollbackHost = {
  createScrollbackSurface(options?: { startOnNewLine?: boolean }): ScrollbackSurface;
};

type ActiveBlock = {
  block: TuiEventBlock;
  view: BlockView;
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
 * commits every row its view reports stable (`BlockView.stableRows`) as text
 * arrives and keeps the still-changing rows back. The first `live` block (running tool, pending approval,
 * ...) stops the writer so scrollback never goes out of order; it and every
 * later block are returned as pending for the footer to show.
 */
export class ScrollbackWriter {
  private readonly host: ScrollbackHost;
  private readonly theme: Theme;
  private readonly leadingRows: () => number;
  private readonly cwd: () => string | undefined;
  private readonly committed = new WeakSet<TuiEventBlock>();
  private active: ActiveBlock | undefined;
  /** Type of the last block opened; undefined until the first block of a screen. */
  private lastType: TuiEventBlock["type"] | undefined;
  private pendingBlocks: readonly TuiEventBlock[] = [];

  /** `cwd` lets tool rows show workspace-relative paths. */
  constructor(host: ScrollbackHost, theme: Theme, leadingRows: () => number = () => 0, cwd: () => string | undefined = () => undefined) {
    this.host = host;
    this.theme = theme;
    this.leadingRows = leadingRows;
    this.cwd = cwd;
  }

  /** Blocks not fully in scrollback yet, in transcript order. */
  get pending(): readonly TuiEventBlock[] {
    return this.pendingBlocks;
  }

  sync(blocks: readonly TuiEventBlock[], running: boolean): readonly TuiEventBlock[] {
    if (this.active && !blocks.includes(this.active.block)) this.dropActive();
    if (blocks.length === 0) this.lastType = undefined;
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
      active.view.update(block, false);
      this.commitThrough(active, active.view.surface.height, true);
    } finally {
      active.view.destroy();
    }
    this.committed.add(block);
  }

  private stream(block: TuiEventBlock): void {
    if (!this.active) this.active = this.open(block);
    const active = this.active;
    active.view.update(block, true);
    // Rows past stableRows can still grow or rewrap as text arrives; hold them back.
    this.commitThrough(active, active.view.stableRows());
  }

  /**
   * A blank row separates sections (reasoning, agent work, reply, ...);
   * consecutive tool calls stack into one work section without one.
   */
  private open(block: TuiEventBlock): ActiveBlock {
    const sameSection = this.lastType === "tool" && block.type === "tool";
    this.writeBlankRows(this.lastType === undefined ? this.leadingRows() : sameSection ? 0 : 1);
    this.lastType = block.type;
    const surface = this.host.createScrollbackSurface({ startOnNewLine: true });
    return { block, view: createBlockView(surface, this.theme, block, this.cwd()), committedRows: 0 };
  }

  /**
   * `final` ends the block's last commit with a newline. Without it OpenTUI's
   * scrollback cursor stays at the end of the last text row, and the split
   * footer, which sits just below that cursor, rises one row off the bottom
   * whenever a turn finishes.
   */
  private commitThrough(active: ActiveBlock, endRow: number, final = false): void {
    const surface = active.view.surface;
    const chunk = Math.max(1, Math.floor(MAX_COMMIT_CELLS / Math.max(1, surface.width)));
    if (final && active.committedRows >= endRow) {
      // Everything was streamed already; still end the block on a new line.
      surface.commitRows(endRow, endRow, { trailingNewline: true });
      return;
    }
    while (active.committedRows < endRow) {
      const next = Math.min(endRow, active.committedRows + chunk);
      surface.commitRows(active.committedRows, next, final && next === endRow ? { trailingNewline: true } : undefined);
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
    this.active?.view.destroy();
    this.active = undefined;
  }
}
