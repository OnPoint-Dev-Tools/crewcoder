import type { CrewCoderTheme } from "../theme/theme.js";
import { bold, fg, reset, visibleLength } from "../tui/ansi.js";
import { padRight } from "../tui/layout.js";

/** Duration (ms) of one full pulse (dim → bright → dim) breath. */
export const PULSE_PERIOD_MS = 2200;

/** After this long idle on the home screen, the pulse freezes to a static frame. */
export const PULSE_FREEZE_MS = 3 * 60 * 1000;

/** How dim the trough of the pulse gets, as a fraction of the base color. */
const PULSE_FLOOR = 0.5;

/**
 * Returns the timestamp to drive the pulse with. While the user is active it is
 * just `now`; once they have been idle for `PULSE_FREEZE_MS` it clamps to the
 * freeze instant, so the pulse settles to a static frame with no visual jump.
 *
 * @param idleSince - When the current idle period on the home screen began.
 * @param now - Current time in milliseconds.
 */
export function pulseClock(idleSince: number, now: number): number {
  const freezeAt = idleSince + PULSE_FREEZE_MS;
  return now >= freezeAt ? freezeAt : now;
}

/**
 * Renders an ASCII banner with a single-color brightness pulse: the whole
 * wordmark breathes between a dimmed and a bright shade of the same hue. The
 * brightness is derived purely from `now`, so it animates across the renderer's
 * periodic ticks without any extra state.
 *
 * @param art - The banner rows (block strings).
 * @param width - Target width to center each row within.
 * @param theme - Active theme; supplies the pulse colors.
 * @param now - Current time in milliseconds (defaults to `Date.now()`).
 * @returns Centered, colorized rows ready to drop into the layout.
 */
export function renderBannerPulse(
  art: readonly string[],
  width: number,
  theme: CrewCoderTheme,
  now: number = Date.now()
): string[] {
  // 0 at the trough, 1 at the peak of the breath.
  const t = (Math.sin((now / PULSE_PERIOD_MS) * Math.PI * 2) + 1) / 2;
  const dim = scaleHex(theme.accent, PULSE_FLOOR);
  const color = lerpHex(dim, theme.glow, t);
  const prefix = `${bold()}${fg(color)}`;

  return art.map((line) => centerBanner(`${prefix}${line}${reset()}`, width));
}

function centerBanner(content: string, width: number): string {
  const left = Math.max(0, Math.floor((width - visibleLength(content)) / 2));
  return padRight(" ".repeat(left) + content, width);
}

function parseHex(hex: string): [number, number, number] {
  const normalized = hex.replace("#", "");
  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16)
  ];
}

function toHex(r: number, g: number, b: number): string {
  const channel = (value: number) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0");
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

function lerpHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = parseHex(a);
  const [br, bg, bb] = parseHex(b);
  return toHex(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t);
}

function scaleHex(hex: string, factor: number): string {
  const [r, g, b] = parseHex(hex);
  return toHex(r * factor, g * factor, b * factor);
}
