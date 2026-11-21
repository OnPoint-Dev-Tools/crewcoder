import { mixHex, type LogoColors } from "./theme.js";

/**
 * Welcome-logo pulse, ported from legacy `crewcoder-tui` `logo-banner.ts`: the
 * whole wordmark breathes in one color between a dimmed accent and the glow
 * color (a pulse, not a sweep). Pure so the timing and colors are testable.
 */

/** One full breath (dim -> bright -> dim). Same as legacy. */
export const PULSE_PERIOD_MS = 2200;

/** After this long without a key on the welcome screen the pulse freezes. Same as legacy. */
export const PULSE_FREEZE_MS = 3 * 60 * 1000;

/** Frame interval; about 37 frames per breath, enough for a smooth fade. */
export const PULSE_FRAME_MS = 60;

/**
 * The time to drive the pulse with: `now` while the user is active, clamped to
 * the freeze instant once they have been idle for `PULSE_FREEZE_MS`, so the logo
 * settles on its current frame without a jump.
 */
export function pulseClock(idleSince: number, now: number): number {
  return Math.min(now, idleSince + PULSE_FREEZE_MS);
}

/** True once the pulse has frozen and needs no more frames. */
export function pulseFrozen(idleSince: number, now: number): boolean {
  return now >= idleSince + PULSE_FREEZE_MS;
}

/** The logo color at `time`: `dim` at the trough, `bright` at the peak. */
export function logoPulseColor(colors: LogoColors, time: number): string {
  const t = (Math.sin((time / PULSE_PERIOD_MS) * Math.PI * 2) + 1) / 2;
  return mixHex(colors.dim, colors.bright, t);
}
