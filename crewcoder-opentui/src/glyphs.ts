import type { TerminalCapabilities } from "@opentui/core";

/**
 * Which icons the transcript draws. `emoji` is the full-color set (two cells
 * wide); `text` uses single-cell symbols that every terminal draws the same.
 */
export type GlyphSet = "emoji" | "text";

/** Environment override: `emoji`, `text`, or `auto` (default, from the terminal's capabilities). */
export const GLYPHS_ENV = "CREWCODER_TUI_ICONS";

/**
 * Emoji are two cells wide. When the terminal measures them differently from
 * OpenTUI, the next cell overwrites half the glyph and the icon looks clipped.
 * So emoji are used only when OpenTUI's probe confirmed Unicode width handling
 * (`unicode` / `unicode-wide`, e.g. Ghostty, kitty, WezTerm) and no multiplexer
 * sits in between (tmux, screen, and zellij redraw cells with their own width
 * tables). Before the probe answers, or with plain `wcwidth`, use `text`.
 */
export function resolveGlyphSet(capabilities: TerminalCapabilities | null | undefined, override: string | undefined): GlyphSet {
  const forced = override?.trim().toLowerCase();
  if (forced === "emoji" || forced === "text") return forced;
  if (!capabilities) return "text";
  return capabilities.multiplexer === "none" && capabilities.unicode !== "wcwidth" ? "emoji" : "text";
}

/** The Reasoning panel's header icon. */
export function reasoningIcon(glyphs: GlyphSet): string {
  return glyphs === "emoji" ? "💭" : "∴";
}
