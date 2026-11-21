/* @jsxImportSource @opentui/react */
// Vendored from termcn (opentui/confirm). CrewCoder changes:
// - No global useKeyboard: upstream answered on a bare `y`/`n` from anywhere,
//   the same hazard as upstream tool-approval. The choice is controlled
//   (`selected`) and keys are routed by App through DEFAULT_APP_KEYBINDINGS.
// - The message row is omitted when `message` is empty (the question card
//   draws its own wrapped title); the answer row sets flexDirection="row" and
//   height 1; each answer is clickable.
import { useTheme } from "../../hooks/use-theme.js";

export interface ConfirmProps {
  message?: string;
  /** true = the confirm label is highlighted. */
  selected: boolean;
  onConfirm?: () => void;
  onCancel?: () => void;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "default" | "danger";
}

export const Confirm = ({
  message,
  selected,
  onConfirm,
  onCancel,
  confirmLabel = "Yes",
  cancelLabel = "No",
  variant = "default",
}: ConfirmProps) => {
  const theme = useTheme();
  const yesColor = variant === "danger" ? theme.colors.error : theme.colors.primary;
  return (
    <box flexDirection="column" flexShrink={0}>
      {message ? (
        <box flexDirection="row" height={1}>
          <text fg={theme.colors.primary} wrapMode="none">{"? "}</text>
          <text fg={theme.colors.foreground} wrapMode="none">{message}</text>
        </box>
      ) : null}
      <box flexDirection="row" gap={2} height={1}>
        <text fg={selected ? yesColor : theme.colors.mutedForeground} wrapMode="none" onMouseUp={onConfirm}>
          {selected ? <b>{`› ${confirmLabel}`}</b> : `  ${confirmLabel}`}
        </text>
        <text fg={selected ? theme.colors.mutedForeground : theme.colors.foreground} wrapMode="none" onMouseUp={onCancel}>
          {selected ? `  ${cancelLabel}` : <b>{`› ${cancelLabel}`}</b>}
        </text>
      </box>
    </box>
  );
};
