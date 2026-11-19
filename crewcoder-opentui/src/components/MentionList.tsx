import type { ReactNode } from "react";
import { useTheme } from "../hooks/use-theme.js";
import { MENTION_ROWS, mentionWindowStart } from "../path-suggestions.js";
import type { MentionState } from "../mentions.js";

export const MENTION_EMPTY_TEXT = "No matching paths";

/**
 * `@` path suggestions under the composer (legacy "Attach file or folder"
 * popover). At most MENTION_ROWS rows, scrolled to keep the highlighted one
 * visible; `mentionRows` in `path-suggestions.ts` must match what renders
 * here. The composer keeps focus: App routes Up/Down/Enter/Tab/Esc here
 * through DEFAULT_APP_KEYBINDINGS.
 */
export function MentionList({ mention }: { mention: MentionState }): ReactNode {
  const theme = useTheme();
  if (mention.items.length === 0) {
    return <text fg={theme.colors.mutedForeground} height={1} wrapMode="none" flexShrink={0} paddingLeft={2}>{MENTION_EMPTY_TEXT}</text>;
  }
  const start = mentionWindowStart(mention.items.length, mention.cursor);
  const shown = mention.items.slice(start, start + MENTION_ROWS);
  return (
    <box flexDirection="column" width="100%" flexShrink={0}>
      {shown.map((item, offset) => {
        const selected = start + offset === mention.cursor;
        return (
          <box key={item.path} flexDirection="row" height={1} flexShrink={0} paddingLeft={1} backgroundColor={selected ? theme.colors.selection : undefined}>
            <text fg={selected ? theme.colors.primary : theme.colors.mutedForeground} wrapMode="none" flexShrink={0}>{selected ? "▸ " : "  "}</text>
            <text fg={selected ? theme.colors.selectionForeground : theme.colors.foreground} wrapMode="none" flexGrow={1} flexShrink={1}>{item.path}</text>
            {item.type === "directory" ? <text fg={theme.colors.mutedForeground} wrapMode="none" flexShrink={0}> dir </text> : null}
          </box>
        );
      })}
    </box>
  );
}
