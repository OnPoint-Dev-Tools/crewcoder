/* @jsxImportSource @opentui/react */
// Vendored from termcn (opentui/select). CrewCoder changes:
// - No global useKeyboard: upstream moved and submitted on every arrow/Enter,
//   even while another field had focus. The cursor is controlled (`active`)
//   and keys are routed by App through DEFAULT_APP_KEYBINDINGS.
// - Renders precomputed, wrapped `OptionRow`s (question-model.ts) instead of
//   one unwrapped row per option, so long labels and descriptions wrap and the
//   height is known to the split-footer sizer.
// - Rows set flexDirection="row" and height 1; hardcoded "#666" replaced with
//   theme tokens; a click on any row of an option chooses it.
import { useTheme } from "../../hooks/use-theme.js";
import type { OptionRow } from "../../question-model.js";

export interface SelectProps {
  rows: readonly OptionRow[];
  /** Index of the highlighted option. */
  active: number;
  onChoose?: (option: number) => void;
  cursor?: string;
  emptyText?: string;
}

export const Select = ({ rows, active, onChoose, cursor = "›", emptyText = "(no options provided)" }: SelectProps) => {
  const theme = useTheme();
  if (rows.length === 0) {
    return <text fg={theme.colors.mutedForeground} height={1} wrapMode="none" flexShrink={0}>{emptyText}</text>;
  }
  return (
    <box flexDirection="column" flexShrink={0}>
      {rows.map((row, index) => {
        const isActive = row.option === active;
        const choose = row.option >= 0 && onChoose ? () => onChoose(row.option) : undefined;
        if (row.kind === "spacer") return <text key={index} height={1} />;
        if (row.kind === "description") {
          return (
            <text key={index} fg={isActive ? theme.colors.foreground : theme.colors.mutedForeground} height={1} wrapMode="none" paddingLeft={4} onMouseUp={choose}>
              {row.text}
            </text>
          );
        }
        return (
          <box key={index} flexDirection="row" height={1} gap={1} onMouseUp={choose}>
            <text fg={theme.colors.primary} wrapMode="none">{isActive && row.leading ? cursor : " "}</text>
            <text fg={isActive ? theme.colors.primary : theme.colors.foreground} wrapMode="none">
              {isActive ? <b>{row.text}</b> : row.text}
            </text>
          </box>
        );
      })}
    </box>
  );
};
