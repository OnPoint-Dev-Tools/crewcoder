import type { TuiEventBlock } from "@onpoint-dev-tools/crewcoder-tui-core/state/tui-store";

/** A one-line composer: border (2) + one text line. It grows to MAX_COMPOSER_LINES. */
export const COMPOSER_ROWS = 3;
export const MAX_COMPOSER_LINES = 8;

/** Footer parts with a variable height, from `SessionController.footerExtras`. */
export type FooterExtras = {
  /** The status alert above the composer. */
  alertRows?: number;
  /** Composer height including its border; defaults to one line. */
  composerRows?: number;
};

/**
 * Visual lines of `text` word-wrapped to `columns`, as the composer textarea
 * (`wrapMode="word"`) lays it out. Counted from the text because the
 * textarea's own `virtualLineCount` only covers its current viewport, so it
 * could never report more lines than the composer already shows. Counts code
 * points, so double-width characters can undercount; the textarea then scrolls.
 */
export function wrappedLineCount(text: string, columns: number): number {
  const width = Math.max(1, Math.floor(columns));
  let lines = 0;
  for (const logical of text.split("\n")) {
    let used = 0;
    let rows = 1;
    for (const word of logical.split(/(\s+)/).filter(Boolean)) {
      let length = [...word].length;
      if (used + length <= width) {
        used += length;
        continue;
      }
      // Whitespace at a break is absorbed; a word moves to the next row, splitting if longer than a row.
      if (/^\s+$/.test(word)) continue;
      rows += used > 0 ? 1 : 0;
      while (length > width) {
        rows += 1;
        length -= width;
      }
      used = length;
    }
    lines += rows;
  }
  return Math.max(1, lines);
}

/** Composer height for this many visual (wrapped) lines. */
export function composerRows(lines: number): number {
  return Math.max(1, Math.min(MAX_COMPOSER_LINES, lines)) + 2;
}

/**
 * The centered welcome screen shows while the session is empty and idle. Any
 * block (even an error from an unported command) ends it, so nothing in the
 * transcript is hidden behind it.
 */
export function isHome(blocks: readonly TuiEventBlock[], running: boolean): boolean {
  return !running && blocks.length === 0;
}

export const HOME_COMPOSER_MIN_WIDTH = 24;
export const HOME_LOGO_MIN_WIDTH = 70;

/** Composer width on the home screen: 62% of the terminal, like the legacy landing page. */
export function homeComposerWidth(width: number): number {
  // Clamp last so a terminal narrower than the floor never gets a wider composer.
  return Math.min(width, Math.max(HOME_COMPOSER_MIN_WIDTH, Math.floor(width * 0.62)));
}

/** Rows the welcome screen needs below the logo: gap, composer (3), gap, tip, info. */
export const HOME_BODY_ROWS = 8;

/**
 * The big block wordmark, or nothing. Smaller logo variants are not used: when
 * the wordmark does not fit (narrower than 70 columns, or too short to keep the
 * composer whole), the welcome screen shows only the composer.
 */
export function homeLogo(width: number, height: number, logo: readonly string[], extraRows = 0): readonly string[] | undefined {
  const logoWidth = Math.max(0, ...logo.map((line) => line.length));
  // extraRows: an alert and composer lines beyond the first also need room.
  const fits = width >= Math.max(HOME_LOGO_MIN_WIDTH, logoWidth + 2) && height >= logo.length + HOME_BODY_ROWS + extraRows + 2;
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
