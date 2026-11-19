import { TextAttributes, type MouseEvent } from "@opentui/core";
import cliSpinners from "cli-spinners";
import type { ReactNode } from "react";
import type { CrewTaskSnapshot } from "@onpoint-dev-tools/crewcoder-tui-core/state/crew-tasks";
import { useAnimation } from "../hooks/use-animation.js";
import { useTheme } from "../hooks/use-theme.js";
import type { Theme } from "./ui/types.js";
import { sidebarRows, type SidebarState, type SidebarTone } from "../sidebar-model.js";

export type SidebarProps = {
  state: SidebarState;
  tasks: CrewTaskSnapshot | undefined;
  width: number;
  height: number;
  /** Local home directory for `~` in the footer; omit for remote workspaces. */
  home?: string;
  /** The divider was dragged to terminal column `x` (0-based). */
  onDividerDrag: (x: number) => void;
};

const SPINNER = cliSpinners.dots;

/**
 * The right sidebar: a draggable divider, then the rows from `sidebarRows`.
 * The spinner only ticks while a crew worker runs.
 */
export function Sidebar({ state, tasks, width, height, home, onDividerDrag }: SidebarProps): ReactNode {
  const theme = useTheme();
  const running = state.crewWorkers.some((worker) => worker.status === "running");
  const frame = useAnimation({ intervalMs: SPINNER.interval, isActive: running });
  const rows = sidebarRows({ state, tasks, spinner: SPINNER.frames[frame % SPINNER.frames.length] ?? "•", home }, width, height);
  return (
    <box flexDirection="row" height="100%" flexShrink={0}>
      {/* A box, not text: text would start a mouse selection instead of a drag. */}
      <box
        width={1}
        height="100%"
        flexShrink={0}
        border={["left"]}
        borderColor={theme.colors.border}
        onMouseDrag={(event: MouseEvent) => onDividerDrag(event.x)}
      />
      <box width={width} height="100%" flexDirection="column" flexShrink={0} backgroundColor={theme.colors.muted}>
        {rows.map((row, index) => (
          <text key={index} height={1} wrapMode="none" flexShrink={0}>
            {row.map((span, spanIndex) => (
              <span key={spanIndex} fg={toneColor(theme, span.tone)} attributes={(span.bold ? TextAttributes.BOLD : 0) | (span.strike ? TextAttributes.STRIKETHROUGH : 0)}>
                {span.text}
              </span>
            ))}
          </text>
        ))}
      </box>
    </box>
  );
}

function toneColor(theme: Theme, tone: SidebarTone): string {
  switch (tone) {
    case "heading": return theme.colors.accent;
    case "taskHeading":
    case "warning": return theme.colors.warning;
    case "text": return theme.colors.foreground;
    case "count":
    case "muted":
    case "subtle": return theme.colors.mutedForeground;
    case "success": return theme.colors.success;
    case "error": return theme.colors.error;
    case "active": return theme.colors.info;
    case "rule": return theme.colors.border;
    case "brand": return theme.colors.primary;
  }
}
