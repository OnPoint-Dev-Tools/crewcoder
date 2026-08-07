import { fg, reset } from "../tui/ansi.js";

/**
 * Animated frames for the working spinner.
 *
 * The sequence evokes the CrewCode mark: a segmented gear ring that gives way
 * to a diagonal launch bolt before completing the orbit. Each glyph is a
 * single Unicode scalar so status bars and tool rows keep stable layout.
 */
export const SPINNER_FRAMES = ["◜", "◠", "◝", "╱", "◞", "◡", "◟", "╲"] as const;

/** Two-cell logo sweeps for prominent loading states. */
export const LARGE_SPINNER_FRAMES = ["◜╱", "◠╱", "◝╱", "╱◝", "╱◞", "╱◡", "╱◟", "◜╲"] as const;

/** Milliseconds each frame is shown before advancing to the next. */
export const SPINNER_FRAME_MS = 90;

/**
 * Returns the spinner glyph for the given moment in time.
 *
 * The frame is derived purely from the clock, so the spinner stays animated
 * across the renderer's periodic ticks without any per-component state.
 *
 * @param now - Current time in milliseconds (defaults to `Date.now()`).
 * @returns A single-width CrewCode-inspired frame.
 */
export function spinnerFrame(now: number = Date.now()): string {
  const index = spinnerFrameIndex(now);
  return SPINNER_FRAMES[index];
}

function spinnerFrameIndex(now: number): number {
  return Math.floor(now / SPINNER_FRAME_MS) % SPINNER_FRAMES.length;
}

/**
 * Returns a color-wrapped spinner glyph ready to drop into a rendered line.
 *
 * @param color - Foreground hex color for the glyph.
 * @param now - Current time in milliseconds (defaults to `Date.now()`).
 * @returns The colored spinner frame with an ANSI reset appended.
 */
export function renderSpinner(color: string, now: number = Date.now()): string {
  return `${fg(color)}${spinnerFrame(now)}${reset()}`;
}

/**
 * Returns a larger two-cell spinner for prominent loading states.
 *
 * The two-cell sweep mirrors the logo's diagonal rocket/bolt crossing the gear
 * ring while still preserving predictable terminal layout width.
 */
export function renderLargeSpinner(color: string, now: number = Date.now()): string {
  const frame = LARGE_SPINNER_FRAMES[spinnerFrameIndex(now)];
  return `${fg(color)}${frame}${reset()}`;
}
