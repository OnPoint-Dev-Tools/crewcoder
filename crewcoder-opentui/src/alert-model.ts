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

/** Most body lines an alert shows; longer output ends with a "… N more lines" row. */
export const MAX_ALERT_BODY_LINES = 12;

/** Body rows as rendered: normalized, trailing blanks dropped, clamped. */
export function alertLines(alert: FooterAlert): string[] {
  const lines = normalize(alert.body ?? "").replace(/\s+$/, "").split("\n");
  if (lines.length === 1 && lines[0] === "") return [];
  if (lines.length <= MAX_ALERT_BODY_LINES) return lines;
  const shown = lines.slice(0, MAX_ALERT_BODY_LINES - 1);
  return [...shown, `… ${lines.length - shown.length} more lines`];
}

/** Footer rows the alert takes: border (2) + title row + body rows. */
export function alertRows(alert: FooterAlert | undefined): number {
  return alert ? 3 + alertLines(alert).length : 0;
}
