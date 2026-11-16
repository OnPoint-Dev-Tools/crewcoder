import type { Theme } from "./components/ui/types.js";
import { defaultTheme } from "./lib/terminal-themes/default.js";
import type { TranscriptTone } from "./transcript.js";

/**
 * Gotham, CrewCoder's base identity (shared with the legacy TUI's default
 * `dark` theme), expressed as termcn theme tokens. The background, border, and
 * primary colors are fixed by the project; the rest are Gotham palette colors.
 */
export const gothamTheme: Theme = {
  ...defaultTheme,
  name: "gotham",
  border: { color: "#195466", focusColor: "#33859e", style: "rounded" },
  colors: {
    background: "#0c1014",
    foreground: "#99d1ce",
    primary: "#33859e",
    primaryForeground: "#0c1014",
    secondary: "#245361",
    secondaryForeground: "#99d1ce",
    accent: "#d26937",
    accentForeground: "#0c1014",
    success: "#2aa889",
    successForeground: "#0c1014",
    warning: "#edb443",
    warningForeground: "#0c1014",
    error: "#c23127",
    errorForeground: "#99d1ce",
    info: "#599cab",
    infoForeground: "#0c1014",
    muted: "#11151c",
    mutedForeground: "#599cab",
    border: "#195466",
    focusRing: "#33859e",
    selection: "#245361",
    selectionForeground: "#99d1ce"
  }
};

/** Gotham violet for reasoning text; termcn has no dedicated token for it. */
export const THINKING_COLOR = "#888ca6";

export function toneColor(theme: Theme, tone: TranscriptTone): string {
  switch (tone) {
    case "user": return theme.colors.primary;
    case "assistant": return theme.colors.success;
    case "thinking": return THINKING_COLOR;
    case "tool": return theme.colors.info;
    case "approval": return theme.colors.warning;
    case "error": return theme.colors.error;
    case "system":
    case "muted": return theme.colors.mutedForeground;
  }
}

export function bodyColor(theme: Theme, tone: TranscriptTone): string {
  return tone === "thinking" ? THINKING_COLOR : theme.colors.foreground;
}
