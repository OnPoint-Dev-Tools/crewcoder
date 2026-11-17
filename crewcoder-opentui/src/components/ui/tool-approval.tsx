/* @jsxImportSource @opentui/react */
// Vendored from termcn (opentui/tool-approval). CrewCoder changes:
// - Inline rows set flexDirection="row": OpenTUI (Yoga) defaults to column,
//   unlike Ink, so upstream rows stacked and collapsed inside height-1 boxes.
// - No global useKeyboard. Approval is resolved by the caller's configured
//   chords or by selecting the visible mouse controls.
// - No auto-deny timer; approvals wait for an explicit decision.
// - `risk` has no default: an unknown risk shows no badge instead of claiming
//   LOW RISK.
// - One-line, non-wrapping rows with a bounded argument list, so the height is
//   deterministic (see toolApprovalHeight) for split-footer sizing.
import { useTheme } from "../../hooks/use-theme.js";

export type RiskLevel = "low" | "medium" | "high";

export interface ToolApprovalProps {
  name: string;
  description?: string;
  args?: Record<string, unknown>;
  risk?: RiskLevel;
  onApprove: () => void;
  onDeny: () => void;
  maxArgs?: number;
}

const DEFAULT_MAX_ARGS = 3;

/** Rows the card occupies, including its border. Must match the layout below. */
export const toolApprovalHeight = ({ description, args, maxArgs = DEFAULT_MAX_ARGS }: Pick<ToolApprovalProps, "description" | "args" | "maxArgs">): number => {
  const argCount = args ? Object.keys(args).length : 0;
  const argRows = argCount === 0 ? 0 : 1 + Math.min(argCount, maxArgs) + (argCount > maxArgs ? 1 : 0);
  return 2 + 1 + 1 + (description ? 1 : 0) + argRows + 1;
};

export const ToolApproval = ({
  name,
  description,
  args,
  risk,
  onApprove,
  onDeny,
  maxArgs = DEFAULT_MAX_ARGS,
}: ToolApprovalProps) => {
  const theme = useTheme();
  const muted = theme.colors.mutedForeground;
  const riskColor: Record<RiskLevel, string> = {
    high: theme.colors.error,
    low: theme.colors.success,
    medium: theme.colors.warning,
  };
  const entries = args ? Object.entries(args) : [];
  const shown = entries.slice(0, maxArgs);

  return (
    <box
      flexDirection="column"
      flexShrink={0}
      border
      borderStyle="rounded"
      borderColor={risk ? riskColor[risk] : theme.colors.warning}
      paddingLeft={1}
      paddingRight={1}
    >
      <box flexDirection="row" gap={2} height={1}>
        <text fg={theme.colors.foreground} wrapMode="none">
          <b>Tool Approval Required</b>
        </text>
        {risk ? (
          <text fg={riskColor[risk]} wrapMode="none">
            <b>{`[${risk.toUpperCase()} RISK]`}</b>
          </text>
        ) : null}
      </box>

      <box flexDirection="row" gap={1} height={1}>
        <text fg={muted}>Tool:</text>
        <text fg={theme.colors.primary} wrapMode="none">
          <b>{name}</b>
        </text>
      </box>
      {description ? (
        <text fg={muted} height={1} wrapMode="none">{description}</text>
      ) : null}

      {entries.length > 0 ? (
        <box flexDirection="column">
          <text fg={muted} height={1}>Arguments:</text>
          {shown.map(([k, v]) => (
            <box key={k} flexDirection="row" gap={1} height={1} paddingLeft={2}>
              <text fg={theme.colors.accent} wrapMode="none">{`${k}:`}</text>
              <text fg={muted} wrapMode="none">{oneLine(v)}</text>
            </box>
          ))}
          {entries.length > maxArgs ? (
            <text fg={muted} height={1} paddingLeft={2}>{`… ${entries.length - maxArgs} more`}</text>
          ) : null}
        </box>
      ) : null}

      <box flexDirection="row" gap={1} height={1}>
        <box height={1} paddingLeft={1} paddingRight={1} backgroundColor={theme.colors.secondary} onMouseUp={onApprove}>
          <text fg={theme.colors.success} wrapMode="none"><b>Approve</b></text>
        </box>
        <box height={1} paddingLeft={1} paddingRight={1} backgroundColor={theme.colors.secondary} onMouseUp={onDeny}>
          <text fg={theme.colors.error} wrapMode="none"><b>Deny</b></text>
        </box>
      </box>
    </box>
  );
};

const oneLine = (value: unknown): string => {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  return text.replace(/\s+/g, " ");
};
