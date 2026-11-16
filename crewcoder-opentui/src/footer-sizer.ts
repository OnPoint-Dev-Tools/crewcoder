import type { TuiEventBlock } from "@onpoint-dev-tools/crewcoder-tui-core/state/tui-store";
import { footerHeight, footerModel, isHome } from "./footer-layout.js";

export type FooterHost = { footerHeight: number; readonly terminalHeight: number; readonly height: number };

type FooterState = { readonly blocks: readonly TuiEventBlock[]; readonly running: boolean };
type FooterScrollback = { readonly pending: readonly TuiEventBlock[] };

/** Set the split-footer height for the current state; see attachScrollback for ordering. */
export function applyFooterHeight(host: FooterHost, state: FooterState, scrollback: FooterScrollback): void {
  const rows = footerHeight({
    home: isHome(state.blocks, state.running),
    contentRows: footerModel(scrollback.pending, state.running).rows,
    terminalHeight: host.terminalHeight
  });
  if (host.footerHeight !== rows) host.footerHeight = rows;
}

/**
 * Before writing: if the session just left the welcome screen, shrink the
 * full-height footer to the conversation footer first. Only this transition is
 * handled here; other sizing waits until after the write, because sizing from
 * the previous sync's pending blocks over-counts (a just-finished reply would
 * briefly grow the footer, and a footer that grows then shrinks ends up one row
 * off the bottom, since OpenTUI shrinks a split footer by keeping its top row).
 */
export function prepareFooterForWrites(host: FooterHost, state: FooterState): void {
  if (isHome(state.blocks, state.running) || host.footerHeight < host.terminalHeight) return;
  const rows = footerModel([], state.running).rows;
  if (host.footerHeight !== rows) host.footerHeight = rows;
}

/**
 * Whether the renderer has applied the requested footer height. In split-footer
 * mode `height` is the footer region, updated only when the resize is applied.
 */
export function footerSettled(host: FooterHost): boolean {
  return host.height === Math.min(host.footerHeight, host.terminalHeight);
}
