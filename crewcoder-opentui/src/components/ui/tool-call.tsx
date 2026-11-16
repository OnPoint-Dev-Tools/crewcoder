/* @jsxImportSource @opentui/react */
// Vendored from termcn (opentui/tool-call). CrewCoder changes:
// - Inline rows set flexDirection="row": OpenTUI (Yoga) defaults to column,
//   unlike Ink, so upstream rows stacked instead of sitting side by side.
// - No global useKeyboard (it toggled every instance on Enter/Space, including
//   while typing in the composer); `collapsed` is controlled by the caller.
// - The spinner and elapsed timer only run while the tool is running.
// - Theme tokens replace hardcoded #666.
import { useEffect, useState } from "react";

import { useTheme } from "../../hooks/use-theme.js";

export type ToolCallStatus = "pending" | "running" | "success" | "error";

export interface ToolCallProps {
  name: string;
  args?: Record<string, unknown>;
  status: ToolCallStatus;
  result?: unknown;
  duration?: number;
  collapsible?: boolean;
  collapsed?: boolean;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export const ToolCall = ({
  name,
  args,
  status,
  result,
  duration,
  collapsible = true,
  collapsed = true,
}: ToolCallProps) => {
  const theme = useTheme();
  const [elapsed, setElapsed] = useState(0);
  const [frame, setFrame] = useState(0);
  const muted = theme.colors.mutedForeground;

  useEffect(() => {
    if (status !== "running") {
      return;
    }
    const startedAt = Date.now();
    const id = setInterval(() => {
      setFrame((f) => f + 1);
      setElapsed(Date.now() - startedAt);
    }, Math.round(1000 / 12));
    return () => clearInterval(id);
  }, [status]);

  const statusIcon = () => {
    switch (status) {
      case "pending": {
        return <text fg={muted}>○</text>;
      }
      case "running": {
        return <text fg={theme.colors.primary}>{SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? "⠋"}</text>;
      }
      case "success": {
        return <text fg={theme.colors.success}>✓</text>;
      }
      case "error": {
        return <text fg={theme.colors.error}>✗</text>;
      }
    }
  };

  let durationText: string | null;
  if (duration === undefined) {
    durationText = status === "running" ? `${elapsed}ms` : null;
  } else {
    durationText = `${duration}ms`;
  }

  let nameColor: string;
  if (status === "error") {
    nameColor = theme.colors.error;
  } else if (status === "success") {
    nameColor = theme.colors.success;
  } else if (status === "running") {
    nameColor = theme.colors.primary;
  } else {
    nameColor = muted;
  }

  return (
    <box flexDirection="column">
      <box flexDirection="row" gap={1}>
        {statusIcon()}
        <text fg={nameColor}>
          {status !== "pending" ? <b>{name}</b> : name}
        </text>
        {durationText && (
          <text fg={muted}>{`(${durationText})`}</text>
        )}
        {collapsible && <text fg={muted}>{collapsed ? "▶" : "▼"}</text>}
      </box>

      {!collapsed && (
        <box flexDirection="column" paddingLeft={2}>
          {args && Object.keys(args).length > 0 && (
            <box flexDirection="column">
              <text fg={muted}>Args:</text>
              {Object.entries(args).map(([k, v]) => (
                <box key={k} flexDirection="row" gap={1}>
                  <text fg={theme.colors.accent}>{`${k}:`}</text>
                  <text fg={muted}>{JSON.stringify(v)}</text>
                </box>
              ))}
            </box>
          )}
          {result !== undefined && (
            <box flexDirection="column">
              <text fg={muted}>Result:</text>
              <text fg={muted}>
                {typeof result === "string"
                  ? result
                  : JSON.stringify(result, null, 2)}
              </text>
            </box>
          )}
        </box>
      )}
    </box>
  );
};
