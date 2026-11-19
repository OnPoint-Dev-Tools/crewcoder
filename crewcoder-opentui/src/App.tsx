import os from "node:os";
import type { InputRenderable, ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { alertLines } from "./alert-model.js";
import { Alert } from "./components/ui/alert.js";
import { Spinner } from "./components/ui/spinner.js";
import { ToolApproval, type RiskLevel } from "./components/ui/tool-approval.js";
import { CommandPalette } from "./components/ui/command-palette.js";
import { Composer } from "./components/Composer.js";
import { ExtensionQuestion } from "./components/ExtensionQuestion.js";
import { Home } from "./components/Home.js";
import { SummaryEditor } from "./components/SummaryEditor.js";
import { Transcript } from "./components/Transcript.js";
import { COMPOSER_ROWS, isHome, shortenPath } from "./footer-layout.js";
import { useTheme } from "./hooks/use-theme.js";
import { actionLabel, matchesAction, type KeyLike } from "./keybindings.js";
import { summaryEditorTextRows, type SessionController } from "./session-controller.js";

export type AppProps = {
  controller: SessionController;
  onQuit: () => void;
};

/**
 * The full-screen UI: the conversation in a scrollbox, and below it a footer
 * that holds only the working spinner, alerts (errors and command results),
 * the approval card, the composer, and the status line. Running tools and
 * streaming text live in the transcript, never in the footer.
 */
export function App({ controller, onQuit }: AppProps): ReactNode {
  useSyncExternalStore(controller.subscribe, controller.getVersion);
  const { width, height } = useTerminalDimensions();
  const theme = useTheme();
  const inputRef = useRef<TextareaRenderable>(null);
  const editorRef = useRef<TextareaRenderable>(null);
  const questionInputRef = useRef<InputRenderable>(null);
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const state = controller.state;
  const picker = controller.picker;
  const editor = controller.editor;
  const question = controller.question();
  const questionView = controller.questionView(height, width);
  const overlayOpen = picker !== undefined || editor !== undefined || question !== undefined;
  const extras = controller.footerExtras();
  const home = isHome(state.blocks, state.running);
  const approval = state.running ? controller.pendingApproval() : undefined;

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
    // take keys before a picker.
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
    if (handleTranscriptKey(key)) return;
    if (approval && matchesAction(key, "approve")) controller.resolvePendingApproval(true);
    else if (approval && matchesAction(key, "deny")) controller.resolvePendingApproval(false);
    else if (matchesAction(key, "abort")) controller.abort();
  });

  /** Scrolling and Ctrl+O; true when the key was used. */
  function handleTranscriptKey(key: KeyLike): boolean {
    const scroll = scrollRef.current;
    if (matchesAction(key, "toggleToolOutput")) controller.toggleAllToolOutput();
    else if (matchesAction(key, "toggleDiffs")) controller.toggleAllDiffs();
    else if (matchesAction(key, "transcriptPageUp")) scroll?.scrollBy(-1, "viewport");
    else if (matchesAction(key, "transcriptPageDown")) scroll?.scrollBy(1, "viewport");
    else if (matchesAction(key, "transcriptTop")) scroll?.scrollTo(0);
    else if (matchesAction(key, "transcriptBottom")) scroll?.scrollTo(Number.POSITIVE_INFINITY);
    else return false;
    key.preventDefault?.();
    return true;
  }

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
      controller.scrollQuestion(scroll, height, width);
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

  // Overlays replace the footer (and the welcome screen); the transcript stays above them.
  const view = controller.pickerView(height);
  const overlay = editor ? (
    <SummaryEditor editor={editor} editorRef={editorRef} textRows={summaryEditorTextRows(height)} />
  ) : question && questionView ? (
    <ExtensionQuestion block={question} view={questionView} inputRef={questionInputRef} onChoose={(choice) => controller.chooseQuestion(choice)} />
  ) : picker && view ? (
    <box width="100%" alignItems="center" flexShrink={0}>
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
  ) : null;

  if (home) {
    return (
      <box width="100%" height="100%" backgroundColor={theme.colors.background} justifyContent="center">
        {overlay ?? (
          <Home
            width={width}
            height={height}
            info={homeInfo(state.provider, state.model, state.cwd, state.remoteTarget, width)}
            composer={composer}
            alert={alert}
            extraRows={(extras.alertRows ?? 0) + (extras.composerRows ?? COMPOSER_ROWS) - COMPOSER_ROWS}
          />
        )}
      </box>
    );
  }

  const last = state.blocks.at(-1);
  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={theme.colors.background}>
      <Transcript blocks={state.blocks} running={state.running} cwd={state.cwd} expansion={controller.toolExpansion} scrollRef={scrollRef} />
      <box flexDirection="column" width="100%" flexShrink={0} marginTop={1}>
        {overlay ?? (
          <>
            {state.running ? (
              <box flexDirection="row" height={1} flexShrink={0} paddingLeft={1}>
                <Spinner label={last?.type === "thinking" ? "Thinking" : "Working"} />
                <text fg={theme.colors.mutedForeground} wrapMode="none">{`  ${actionLabel("abort")} to stop`}</text>
              </box>
            ) : null}
            {approval ? (
              <ToolApproval
                name={approval.toolName ?? "tool"}
                description={approval.text}
                args={approval.args}
                risk={riskLevel(approval.risk)}
                onApprove={() => controller.resolvePendingApproval(true)}
                onDeny={() => controller.resolvePendingApproval(false)}
              />
            ) : null}
            {alert}
            {composer}
            <text fg={theme.colors.mutedForeground} height={1} wrapMode="none" flexShrink={0} paddingLeft={1}>{status}</text>
          </>
        )}
      </box>
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
