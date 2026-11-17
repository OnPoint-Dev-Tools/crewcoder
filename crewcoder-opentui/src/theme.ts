import type { Theme } from "./components/ui/types.js";
import { defaultTheme } from "./lib/terminal-themes/default.js";
import type { TranscriptTone } from "./transcript.js";

/** Minimal slate palette for the OpenTUI footer and native transcript. */
export const slateTheme: Theme = {
  ...defaultTheme,
  name: "slate",
  border: { color: "#3b414b", focusColor: "#a7adb7", style: "rounded" },
  colors: {
    background: "#101216",
    foreground: "#d3d6dc",
    primary: "#a7adb7",
    primaryForeground: "#101216",
    secondary: "#292d34",
    secondaryForeground: "#d3d6dc",
    accent: "#c0c5ce",
    accentForeground: "#101216",
    success: "#aab8ad",
    successForeground: "#101216",
    warning: "#c4b99f",
    warningForeground: "#101216",
    error: "#c28f91",
    errorForeground: "#101216",
    info: "#a7adb7",
    infoForeground: "#101216",
    muted: "#181b20",
    mutedForeground: "#858c97",
    border: "#3b414b",
    focusRing: "#a7adb7",
    selection: "#343942",
    selectionForeground: "#e0e3e8"
  }
};

/** Muted slate for reasoning text; termcn has no dedicated token for it. */
export const THINKING_COLOR = "#858c97";

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
