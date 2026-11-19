/* @jsxImportSource @opentui/react */
// Adapted from termcn (opentui/command-palette). CrewCoder changes:
// - Presentation only: App routes keys through DEFAULT_APP_KEYBINDINGS so the
//   palette cannot race the composer or other global handlers.
// - Uses CrewCoder slate theme tokens instead of hardcoded colors.
// - Renders a precomputed PickerView (palette-model.ts) so the same component
//   serves every picker, scrolls long lists, and matches footer sizing exactly.
// - Optional border title and a marker for the current value.
// - Optional hint row text, for pickers with extra keys (/sessions: Tab branch).
import type { ReactNode } from "react";
import { useTheme } from "../../hooks/use-theme.js";
import type { PickerView } from "../../palette-model.js";

export type { PaletteCommand } from "../../palette-model.js";

export interface CommandPaletteProps {
  view: PickerView;
  query: string;
  title?: string;
  placeholder?: string;
  /** Shown instead of the list when it is empty. */
  emptyText?: string;
  /** Key hint row; defaults to navigate/select/close. */
  hint?: string;
}

export function CommandPalette({ view, query, title, placeholder = "Search commands…", emptyText = "No commands found", hint = "↑↓ navigate · Enter select · Esc close" }: CommandPaletteProps): ReactNode {
  const theme = useTheme();
  const position = view.total > view.rows.filter((row) => row.kind === "item").length ? ` · ${view.selectedIndex + 1}/${view.total}` : "";
  return (
    <box flexDirection="column" border borderStyle="rounded" borderColor={theme.colors.focusRing} title={title ? ` ${title} ` : undefined} titleColor={theme.colors.mutedForeground} paddingLeft={1} paddingRight={1}>
      <box flexDirection="row" border borderStyle="single" borderColor={theme.colors.border} paddingLeft={1} paddingRight={1} flexShrink={0}>
        <text fg={theme.colors.mutedForeground}>⌘ </text>
        <text fg={query ? theme.colors.foreground : theme.colors.mutedForeground}>{query || placeholder}</text>
        <text fg={theme.colors.focusRing}>█</text>
      </box>
      {view.rows.length === 0 ? (
        <box paddingLeft={1} paddingRight={1} height={1} flexShrink={0}>
          <text fg={theme.colors.mutedForeground} wrapMode="none">{emptyText}</text>
        </box>
      ) : (
        view.rows.map((row) => {
          if (row.kind === "header") {
            return <text key={`group:${row.label}`} fg={theme.colors.mutedForeground} height={1} wrapMode="none" flexShrink={0}><b>{row.label}</b></text>;
          }
          const selected = row.index === view.selectedIndex;
          return (
            <box key={`item:${row.item.id}`} flexDirection="row" paddingLeft={1} paddingRight={1} height={1} flexShrink={0}>
              <text fg={selected ? theme.colors.selectionForeground : theme.colors.foreground} bg={selected ? theme.colors.selection : undefined} wrapMode="none" flexShrink={0}>
                {selected ? <b>{row.item.label}</b> : row.item.label}
              </text>
              {row.item.current ? <text fg={theme.colors.focusRing} wrapMode="none" flexShrink={0}>{" ●"}</text> : null}
              {row.item.description ? <text fg={theme.colors.mutedForeground} wrapMode="none">{` — ${row.item.description}`}</text> : null}
            </box>
          );
        })
      )}
      <text fg={theme.colors.mutedForeground} height={1} wrapMode="none" flexShrink={0}>{`${hint}${position}`}</text>
    </box>
  );
}
