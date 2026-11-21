import { wrapIndented } from "./text-wrap.js";
import { normalize } from "./transcript.js";

export type AlertVariant = "success" | "error" | "warning" | "info";

/**
 * A status message shown above the composer until the next keypress or
 * command: on/off/status results and the text output of one-shot commands.
 */
export type FooterAlert = {
  variant: AlertVariant;
  title: string;
  body?: string;
};

/** Most body rows (after wrapping) an alert shows; longer output ends with a "… N more lines" row. */
export const MAX_ALERT_BODY_LINES = 16;

/** Columns the alert box itself takes: its border (1 + 1) and padding (1 + 1). */
export const ALERT_CHROME_COLUMNS = 4;

/** The icon and the gap after it, before the title text. */
export const ALERT_ICON_COLUMNS = 2;

/** What an alert draws at a box width: the title and body, wrapped (never cut) to fit. */
export type AlertView = { title: string[]; lines: string[] };

/**
 * Title and body rows at `width` (the alert box's outer width). Text wraps to the
 * room inside the border and padding, keeping each line's indent and hanging a list
 * item's continuation under its text; the title wraps beside its icon. The body is
 * clamped after wrapping, so `alertRows` is exactly what draws.
 */
export function alertView(alert: FooterAlert, width: number): AlertView {
  const inner = Math.max(1, width - ALERT_CHROME_COLUMNS);
  const title = wrapIndented(normalize(alert.title), Math.max(1, inner - ALERT_ICON_COLUMNS));
  const body = normalize(alert.body ?? "").replace(/\s+$/, "");
  if (!body) return { title, lines: [] };
  const lines = wrapIndented(body, inner);
  if (lines.length <= MAX_ALERT_BODY_LINES) return { title, lines };
  const shown = lines.slice(0, MAX_ALERT_BODY_LINES - 1);
  return { title, lines: [...shown, `… ${lines.length - shown.length} more lines`] };
}

/** Footer rows the alert takes at `width`: border (2) + title rows + body rows. */
export function alertRows(alert: FooterAlert | undefined, width: number): number {
  if (!alert) return 0;
  const view = alertView(alert, width);
  return 2 + view.title.length + view.lines.length;
}
