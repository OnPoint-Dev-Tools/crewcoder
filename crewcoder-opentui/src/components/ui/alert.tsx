/* @jsxImportSource @opentui/react */
// Adapted from termcn (opentui/alert). CrewCoder changes:
// - The icon/title row sets flexDirection="row"; upstream `<box gap={1}>` stacks
//   them in OpenTUI, whose boxes default to column.
// - The bordered variant sets `border`; upstream passed only borderColor/style,
//   which draws no border in OpenTUI.
// - Title and body come pre-wrapped (`alertView`, `alert-model.ts`) and draw as
//   one-row lines, so long text wraps instead of being cut at the border and the
//   height is exactly `alertRows()`, which sizes the footer.
// - Unused props (custom icon/color/padding/borderless) removed.
import type { ReactNode } from "react";
import { ALERT_ICON_COLUMNS, type AlertVariant, type AlertView } from "../../alert-model.js";
import { useTheme } from "../../hooks/use-theme.js";

export type { AlertVariant } from "../../alert-model.js";

const ICONS: Record<AlertVariant, string> = {
  error: "✗",
  info: "ℹ",
  success: "✓",
  warning: "⚠"
};

export interface AlertProps {
  variant?: AlertVariant;
  view: AlertView;
}

export function Alert({ variant = "info", view }: AlertProps): ReactNode {
  const theme = useTheme();
  const color = variant === "success" ? theme.colors.success
    : variant === "error" ? theme.colors.error
      : variant === "warning" ? theme.colors.warning
        : theme.colors.info;
  return (
    <box border borderColor={color} borderStyle={theme.border.style} flexDirection="column" paddingLeft={1} paddingRight={1} flexShrink={0}>
      {view.title.map((line, index) => (
        <box key={`title-${index}`} flexDirection="row" height={1} flexShrink={0}>
          <text fg={color} wrapMode="none" width={ALERT_ICON_COLUMNS} flexShrink={0}><b>{index === 0 ? ICONS[variant] : " "}</b></text>
          <text fg={color} wrapMode="none"><b>{line}</b></text>
        </box>
      ))}
      {view.lines.map((line, index) => (
        <text key={index} fg={theme.colors.foreground} height={1} wrapMode="none" flexShrink={0}>{line || " "}</text>
      ))}
    </box>
  );
}
