/* @jsxImportSource @opentui/react */
// Adapted from termcn (opentui/alert). CrewCoder changes:
// - The icon/title row sets flexDirection="row"; upstream `<box gap={1}>` stacks
//   them in OpenTUI, whose boxes default to column.
// - The bordered variant sets `border`; upstream passed only borderColor/style,
//   which draws no border in OpenTUI.
// - Body renders as fixed one-row lines (`lines`) instead of wrapping children,
//   so the height is exactly `alertRows()` and the footer can be sized for it.
// - Unused props (custom icon/color/padding/borderless) removed.
import type { ReactNode } from "react";
import type { AlertVariant } from "../../alert-model.js";
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
  title: string;
  lines?: readonly string[];
}

export function Alert({ variant = "info", title, lines = [] }: AlertProps): ReactNode {
  const theme = useTheme();
  const color = variant === "success" ? theme.colors.success
    : variant === "error" ? theme.colors.error
      : variant === "warning" ? theme.colors.warning
        : theme.colors.info;
  return (
    <box border borderColor={color} borderStyle={theme.border.style} flexDirection="column" paddingLeft={1} paddingRight={1} flexShrink={0}>
      <box flexDirection="row" gap={1} height={1} flexShrink={0}>
        <text fg={color} wrapMode="none" flexShrink={0}><b>{ICONS[variant]}</b></text>
        <text fg={color} wrapMode="none"><b>{title}</b></text>
      </box>
      {lines.map((line, index) => (
        <text key={index} fg={theme.colors.foreground} height={1} wrapMode="none" flexShrink={0}>{line}</text>
      ))}
    </box>
  );
}
