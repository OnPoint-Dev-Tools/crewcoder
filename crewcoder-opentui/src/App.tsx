import os from "node:os";
import type { InputRenderable, TextareaRenderable } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { alertLines } from "./alert-model.js";
import { Alert } from "./components/ui/alert.js";
import { Spinner } from "./components/ui/spinner.js";
import { ToolApproval, type RiskLevel } from "./components/ui/tool-approval.js";
import { ToolCall } from "./components/ui/tool-call.js";
import { CommandPalette } from "./components/ui/command-palette.js";
import { Composer } from "./components/Composer.js";
import { ExtensionQuestion } from "./components/ExtensionQuestion.js";
import { Home } from "./components/Home.js";
import { SummaryEditor } from "./components/SummaryEditor.js";
import { COMPOSER_ROWS, footerModel, isHome, shortenPath, streamingTail } from "./footer-layout.js";
import { useTheme } from "./hooks/use-theme.js";
import { matchesAction, type KeyLike } from "./keybindings.js";
import type { ScrollbackWriter } from "./scrollback-writer.js";
import { summaryEditorTextRows, type SessionController } from "./session-controller.js";
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
  const inputRef = useRef<TextareaRenderable>(null);
  const editorRef = useRef<TextareaRenderable>(null);
  const questionInputRef = useRef<InputRenderable>(null);
  const state = controller.state;
  const picker = controller.picker;
  const editor = controller.editor;
  const question = controller.question();
  const questionView = controller.questionView(renderer.terminalHeight, renderer.terminalWidth);
  const overlayOpen = picker !== undefined || editor !== undefined || question !== undefined;
  const extras = controller.footerExtras(renderer.terminalHeight, renderer.terminalWidth);
  const model = footerModel(scrollback.pending, state.running, extras);
  const home = isHome(state.blocks, state.running);

  useEffect(() => {
    if (overlayOpen) inputRef.current?.blur();
    else inputRef.current?.focus();
  }, [overlayOpen]);

  // Pickers such as /commands hand text to the uncontrolled composer. The
  // composer unmounts while a picker is open, so apply each draft once, after
  // it remounts.
  const appliedDraft = useRef(0);
  useEffect(() => {
    const input = inputRef.current;
    if (controller.composerDraftVersion === appliedDraft.current || !input) return;
    appliedDraft.current = controller.composerDraftVersion;
    input.setText(controller.composerDraft);
    input.gotoBufferEnd();
  }, [controller.composerDraftVersion, controller.composerDraft, overlayOpen]);

  useKeyboard((key: KeyLike) => {
    if (matchesAction(key, "quit")) {
      onQuit();
      return;
    }
    // An alert lasts until the next key; the key itself still does its job.
    controller.dismissAlert();
    // The summary editor and an extension question gate a live run, so they
    // take keys before a picker (matching footerExtras).
    if (controller.editor) {
      handleEditorKey(key);
      return;
    }
    const pending = controller.question();
    if (pending) {
      handleQuestionKey(key, pending.uiKind);
      return;
    }
    // Read overlays live, not from this render: keys typed right after "/"
    // can arrive before React re-renders. Global handlers run before the
    // focused textarea, so preventDefault keeps it from also taking the key
    // (the composer would otherwise submit its leftover text on Enter).
    if (controller.picker) {
      key.preventDefault?.();
      if (matchesAction(key, "paletteClose")) controller.closePicker();
      else if (matchesAction(key, "paletteUp")) controller.movePickerCursor(-1);
      else if (matchesAction(key, "paletteDown")) controller.movePickerCursor(1);
      else if (matchesAction(key, "paletteSelect")) controller.selectPickerItem();
      else if (matchesAction(key, "paletteBackspace")) controller.setPickerQuery(controller.pickerQuery.slice(0, -1));
      else if (!key.ctrl && !key.meta && key.name.length === 1) controller.setPickerQuery(controller.pickerQuery + key.name);
      return;
    }
    if (model.approval && matchesAction(key, "approve")) controller.resolvePendingApproval(true);
    else if (model.approval && matchesAction(key, "deny")) controller.resolvePendingApproval(false);
    else if (matchesAction(key, "abort")) controller.abort();
  });

  function handleEditorKey(key: KeyLike): void {
    const current = controller.editor;
    if (!current) return;
    // Other keys edit the summary in the focused textarea.
    if (matchesAction(key, "summaryApply")) {
      key.preventDefault?.();
      controller.resolveSummary(true, editorRef.current?.plainText ?? current.summary);
    } else if (matchesAction(key, "summaryReset")) {
      key.preventDefault?.();
      editorRef.current?.setText(current.summary);
    } else if (matchesAction(key, "summaryCancel")) {
      key.preventDefault?.();
      controller.resolveSummary(false, "");
    }
  }

  function handleQuestionKey(key: KeyLike, kind: string): void {
    const scroll = matchesAction(key, "questionScrollUp") ? -3 : matchesAction(key, "questionScrollDown") ? 3 : 0;
    if (scroll) {
      key.preventDefault?.();
      controller.scrollQuestion(scroll, renderer.terminalHeight, renderer.terminalWidth);
    } else if (matchesAction(key, "questionCancel")) {
      key.preventDefault?.();
      controller.answerQuestion(null);
    } else if (kind === "input") {
      // Other keys edit the reply in the focused input.
      if (!matchesAction(key, "questionSubmit")) return;
      key.preventDefault?.();
      controller.answerQuestion(questionInputRef.current?.value ?? "");
    } else {
      key.preventDefault?.();
      if (matchesAction(key, "questionPrev")) controller.moveQuestionCursor(-1);
      else if (matchesAction(key, "questionNext")) controller.moveQuestionCursor(1);
      else if (matchesAction(key, "questionSubmit")) controller.submitQuestionChoice();
      else if (kind === "confirm" && matchesAction(key, "questionYes")) controller.answerQuestion(true);
      else if (kind === "confirm" && matchesAction(key, "questionNo")) controller.answerQuestion(false);
    }
  }

  const submit = (text: string): void => {
    // The composer is uncontrolled; clear its buffer after each submission.
    inputRef.current?.setText("");
    controller.setComposerLines(1);
    controller.submit(text);
  };

  const status = [
    state.provider,
    `${state.model} (${state.effort})`,
    state.worker ? `worker ${state.worker}` : state.mode,
    state.sessionId === "new" ? "new session" : state.sessionId
  ].join(" · ");

  const composer = (
    <Composer
      inputRef={inputRef}
      lines={controller.composerLines}
      placeholder={state.running ? "Send a follow-up to the running turn" : "Ask CrewCoder"}
      onLines={(lines) => controller.setComposerLines(lines)}
      onText={(text) => controller.setComposerText(text)}
      onSlash={() => controller.openCommandPalette()}
      onSubmit={submit}
    />
  );

  const alert = controller.currentAlert
    ? <Alert variant={controller.currentAlert.variant} title={controller.currentAlert.title} lines={alertLines(controller.currentAlert)} />
    : null;

  if (editor) {
    return (
      <box width="100%" height="100%" backgroundColor={theme.colors.background} justifyContent={home ? "center" : "flex-start"}>
        <SummaryEditor editor={editor} editorRef={editorRef} textRows={summaryEditorTextRows(renderer.terminalHeight)} />
      </box>
    );
  }

  if (question && questionView) {
    return (
      <box width="100%" height="100%" backgroundColor={theme.colors.background}>
        <ExtensionQuestion block={question} view={questionView} inputRef={questionInputRef} onChoose={(choice) => controller.chooseQuestion(choice)} />
      </box>
    );
  }

  const view = controller.pickerView(renderer.terminalHeight);
  if (picker && view) {
    return (
      <box width="100%" height="100%" backgroundColor={theme.colors.background} justifyContent={home ? "center" : "flex-start"} alignItems="center">
        <box width={Math.max(1, Math.min(width - 2, 80))} flexShrink={0}>
          <CommandPalette
            view={view}
            query={controller.pickerQuery}
            title={picker.title}
            placeholder={picker.placeholder}
            emptyText={picker.loading ? "Loading…" : picker.emptyText}
          />
        </box>
      </box>
    );
  }

  if (home) {
    return (
      <box width="100%" height="100%" backgroundColor={theme.colors.background}>
        <Home
          width={width}
          height={renderer.terminalHeight}
          info={homeInfo(state.provider, state.model, state.cwd, state.remoteTarget, width)}
          composer={composer}
          alert={alert}
          extraRows={(extras.alertRows ?? 0) + (extras.composerRows ?? COMPOSER_ROWS) - COMPOSER_ROWS}
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
      {model.streaming?.type === "thinking" ? (
        // Continues the Reasoning panel's left border above it in scrollback.
        <box flexDirection="row" height={1} flexShrink={0}>
          <text fg={theme.colors.border} wrapMode="none">{"│ "}</text>
          <text fg={toneColor(theme, "thinking")} wrapMode="none">{streamingTail(blockToRow(model.streaming).text, width - 2)}</text>
        </box>
      ) : (
        <text fg={model.streaming ? toneColor(theme, blockToRow(model.streaming).tone) : theme.colors.mutedForeground} height={1} wrapMode="none" flexShrink={0}>
          {model.streaming ? streamingTail(blockToRow(model.streaming).text, width) : ""}
        </text>
      )}
      {model.approval ? (
        <ToolApproval
          name={model.approval.toolName ?? "tool"}
          description={model.approval.text}
          args={model.approval.args}
          risk={riskLevel(model.approval.risk)}
          onApprove={() => controller.resolvePendingApproval(true)}
          onDeny={() => controller.resolvePendingApproval(false)}
        />
      ) : null}
      {/* Reserved row (RESERVED_ROWS): the working spinner, or empty when idle. */}
      {model.working ? (
        <box height={1} flexShrink={0}>
          <Spinner label={model.streaming?.type === "thinking" ? "Thinking" : "Working"} />
        </box>
      ) : (
        <text height={1} wrapMode="none" flexShrink={0} />
      )}
      {alert}
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
