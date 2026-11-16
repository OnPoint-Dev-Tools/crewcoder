import os from "node:os";
import type { InputRenderable } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { useRef, useSyncExternalStore, type ReactNode } from "react";
import { Spinner } from "./components/ui/spinner.js";
import { ToolApproval, type RiskLevel } from "./components/ui/tool-approval.js";
import { ToolCall } from "./components/ui/tool-call.js";
import { Home } from "./components/Home.js";
import { footerModel, isHome, shortenPath, streamingTail } from "./footer-layout.js";
import { useTheme } from "./hooks/use-theme.js";
import { actionLabel, matchesAction, type KeyLike } from "./keybindings.js";
import type { ScrollbackWriter } from "./scrollback-writer.js";
import type { SessionController } from "./session-controller.js";
import { toneColor } from "./theme.js";
import { blockToRow } from "./transcript.js";

export type AppProps = {
  controller: SessionController;
  scrollback: Pick<ScrollbackWriter, "pending">;
  onQuit: () => void;
};

/**
 * The split footer. Settled transcript lives in native scrollback (see
 * ScrollbackWriter); this renders only what is still changing, plus the
 * composer and status line. The footer height is set outside React by
 * applyFooterHeight, in step with scrollback commits.
 */
export function App({ controller, scrollback, onQuit }: AppProps): ReactNode {
  useSyncExternalStore(controller.subscribe, controller.getVersion);
  const renderer = useRenderer();
  // In split-footer mode these are the footer's own dimensions; the hook also
  // re-renders on resize, so renderer.terminalHeight below stays current.
  const { width } = useTerminalDimensions();
  const theme = useTheme();
  const inputRef = useRef<InputRenderable>(null);
  const state = controller.state;
  const model = footerModel(scrollback.pending, state.running);
  const home = isHome(state.blocks, state.running);

  useKeyboard((key: KeyLike) => {
    if (matchesAction(key, "quit")) onQuit();
    else if (model.approval && matchesAction(key, "approve")) controller.resolvePendingApproval(true);
    else if (model.approval && matchesAction(key, "deny")) controller.resolvePendingApproval(false);
    else if (matchesAction(key, "abort")) controller.abort();
  });

  const submit = (value: string): void => {
    controller.submit(value);
    // The input is uncontrolled; clear the native buffer after each submission.
    if (inputRef.current) inputRef.current.value = "";
  };

  const status = [
    state.provider,
    state.model,
    state.mode,
    state.sessionId === "new" ? "new session" : state.sessionId
  ].join(" · ");

  const composer = (
    <box border borderStyle="rounded" borderColor={theme.border.color} height={3} flexShrink={0} paddingLeft={1} paddingRight={1}>
      <input
        ref={inputRef}
        focused
        placeholder={state.running ? "Send a follow-up to the running turn" : "Ask CrewCoder"}
        textColor={theme.colors.foreground}
        onSubmit={submit}
      />
    </box>
  );

  if (home) {
    return (
      <box width="100%" height="100%" backgroundColor={theme.colors.background}>
        <Home
          width={width}
          height={renderer.terminalHeight}
          info={homeInfo(state.provider, state.model, state.cwd, state.remoteTarget, width)}
          hint={`${actionLabel("quit")} quit`}
          composer={composer}
        />
      </box>
    );
  }

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={theme.colors.background}>
      {/* Takes the free space so the live region and composer sit at the bottom. */}
      <box flexGrow={1} />
      {model.other.map((block, index) => {
        const row = blockToRow(block);
        return (
          <text key={`other-${index}`} fg={toneColor(theme, row.tone)} height={1} wrapMode="none" flexShrink={0}>
            {`${row.label} · ${firstLine(row.text)}`}
          </text>
        );
      })}
      {model.tools.map((tool, index) => (
        <box key={tool.id ?? `tool-${index}`} height={1} flexShrink={0}>
          <ToolCall name={tool.name} status="running" args={tool.args} collapsed />
        </box>
      ))}
      {model.hiddenTools > 0 ? (
        <text fg={theme.colors.mutedForeground} height={1} flexShrink={0}>{`… ${model.hiddenTools} more running`}</text>
      ) : null}
      {/* Reserved row (RESERVED_ROWS): the streaming tail, or empty. */}
      <text fg={model.streaming ? toneColor(theme, blockToRow(model.streaming).tone) : theme.colors.mutedForeground} height={1} wrapMode="none" flexShrink={0}>
        {model.streaming ? streamingTail(blockToRow(model.streaming).text, width) : ""}
      </text>
      {model.approval ? (
        <ToolApproval
          name={model.approval.toolName ?? "tool"}
          description={model.approval.text}
          args={model.approval.args}
          risk={riskLevel(model.approval.risk)}
          approveHint={actionLabel("approve")}
          denyHint={actionLabel("deny")}
        />
      ) : null}
      {/* Reserved row (RESERVED_ROWS): the working spinner, or key hints when idle. */}
      {model.working ? (
        <box height={1} flexShrink={0}>
          <Spinner label={`Working · ${actionLabel("abort")} to abort`} />
        </box>
      ) : (
        <text fg={theme.colors.mutedForeground} height={1} wrapMode="none" flexShrink={0} paddingLeft={1}>
          {`${actionLabel("abort")} abort · ${actionLabel("approve")} approve · ${actionLabel("deny")} deny · ${actionLabel("quit")} quit`}
        </text>
      )}
      {composer}
      <text fg={theme.colors.mutedForeground} height={1} wrapMode="none" flexShrink={0} paddingLeft={1}>{status}</text>
    </box>
  );
}

/** Map the agent's ApprovalRisk (`safe | review | dangerous`) onto termcn's levels. */
const RISK_LEVELS: Readonly<Record<string, RiskLevel>> = { safe: "low", review: "medium", dangerous: "high" };

export function riskLevel(value: string | undefined): RiskLevel | undefined {
  // hasOwn guards against prototype keys such as "constructor" in agent data.
  return value !== undefined && Object.hasOwn(RISK_LEVELS, value) ? RISK_LEVELS[value] : undefined;
}

/** `provider · model · cwd`, with the cwd shortened so the line fits and stays centered. */
function homeInfo(provider: string, model: string, cwd: string, remoteTarget: string | undefined, width: number): string {
  const prefix = `${provider} · ${model} · `;
  const location = remoteTarget ? `${remoteTarget}:${cwd}` : cwd;
  const room = Math.max(8, width - 2 - prefix.length);
  return `${prefix}${shortenPath(location, room, remoteTarget ? undefined : os.homedir())}`;
}

function firstLine(text: string): string {
  return text.split("\n", 1)[0] ?? "";
}
