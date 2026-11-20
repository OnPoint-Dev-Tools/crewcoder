import { slateCrewCoderTheme, type CrewCoderTheme, type MarkdownColors, type SyntaxColors } from "@onpoint-dev-tools/crewcoder-tui-core/theme/crewcoder-theme";
import type { Theme } from "./components/ui/types.js";
import { defaultTheme } from "./lib/terminal-themes/default.js";
import type { TranscriptTone } from "./transcript.js";

/** Inline diff row and gutter colors. */
export type DiffColors = {
  addedBg: string;
  removedBg: string;
  addedLineNumberBg: string;
  removedLineNumberBg: string;
  lineNumberBg: string;
};

/**
 * Everything the UI colors with: termcn component tokens (`ui`, through
 * `ThemeProvider`) plus the diff, Tree-sitter, and markdown element colors
 * termcn has no tokens for (through `AppColorsContext`).
 */
export type AppTheme = {
  ui: Theme;
  diff: DiffColors;
  syntax: SyntaxColors;
  markdown: MarkdownColors;
};

/**
 * Map a shared CrewCoder theme (the legacy token set used by theme JSON files)
 * onto termcn tokens, so one file looks the same in both UIs. Text drawn on a
 * colored chip uses the theme background.
 */
export function toAppTheme(crew: CrewCoderTheme): AppTheme {
  const onColor = crew.background;
  const ui: Theme = {
    ...defaultTheme,
    name: crew.name,
    border: { color: crew.border, focusColor: crew.borderStrong, style: "rounded" },
    colors: {
      background: crew.background,
      foreground: crew.text,
      primary: crew.primary,
      primaryForeground: onColor,
      secondary: crew.panelAlt,
      secondaryForeground: crew.text,
      accent: crew.accent,
      accentForeground: onColor,
      success: crew.success,
      successForeground: onColor,
      warning: crew.warning,
      warningForeground: onColor,
      error: crew.danger,
      errorForeground: onColor,
      // The legacy token set has no info color; links and hints use primary.
      info: crew.primary,
      infoForeground: onColor,
      muted: crew.panel,
      mutedForeground: crew.muted,
      border: crew.border,
      focusRing: crew.borderStrong,
      selection: crew.selectedBg,
      selectionForeground: crew.text
    }
  };
  return {
    ui,
    diff: {
      addedBg: crew.diffAddBg,
      removedBg: crew.diffDelBg,
      // Gutters are the row tint lifted slightly toward the text color.
      addedLineNumberBg: mixHex(crew.diffAddBg, crew.text, GUTTER_LIFT),
      removedLineNumberBg: mixHex(crew.diffDelBg, crew.text, GUTTER_LIFT),
      lineNumberBg: crew.backgroundAlt
    },
    syntax: crew.syntax,
    markdown: crew.markdown
  };
}

const GUTTER_LIFT = 0.03;

/** `from` moved `amount` (0..1) of the way to `to`; both `#rrggbb`. */
export function mixHex(from: string, to: string, amount: number): string {
  const channel = (hex: string, index: number): number => Number.parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16);
  return `#${[0, 1, 2].map((index) => {
    const value = Math.round(channel(from, index) + (channel(to, index) - channel(from, index)) * amount);
    return value.toString(16).padStart(2, "0");
  }).join("")}`;
}

/** The default palette (minimal slate). */
export const slateAppTheme: AppTheme = toAppTheme(slateCrewCoderTheme);
/** Slate termcn tokens, for components and tests that only need `ui`. */
export const slateTheme: Theme = slateAppTheme.ui;

export function toneColor(theme: Theme, tone: TranscriptTone): string {
  switch (tone) {
    case "user": return theme.colors.primary;
    case "assistant": return theme.colors.success;
    case "thinking": return theme.colors.mutedForeground;
    case "tool": return theme.colors.info;
    case "approval": return theme.colors.warning;
    case "error": return theme.colors.error;
    case "system":
    case "muted": return theme.colors.mutedForeground;
  }
}

/** Reasoning text is muted; everything else uses the body color. */
export function bodyColor(theme: Theme, tone: TranscriptTone): string {
  return tone === "thinking" ? theme.colors.mutedForeground : theme.colors.foreground;
}
