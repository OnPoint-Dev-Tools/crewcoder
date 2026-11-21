import os from "node:os";
import type { InputRenderable, ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { alertView } from "./alert-model.js";
import { Alert } from "./components/ui/alert.js";
import { AttachmentRow } from "./components/AttachmentRow.js";
import { Spinner } from "./components/ui/spinner.js";
import { ToolApproval, type RiskLevel } from "./components/ui/tool-approval.js";
import { CommandPalette } from "./components/ui/command-palette.js";
import { Composer } from "./components/Composer.js";
import { ExtensionQuestion } from "./components/ExtensionQuestion.js";
import { GoalForm } from "./components/GoalForm.js";
import { Home } from "./components/Home.js";
import { MentionList } from "./components/MentionList.js";
import { SearchBar } from "./components/SearchBar.js";
import { Sidebar } from "./components/Sidebar.js";
import { SummaryEditor } from "./components/SummaryEditor.js";
import { Transcript } from "./components/Transcript.js";
import { COMPOSER_ROWS, homeComposerWidth, isHome, shortenPath } from "./footer-layout.js";
import { useTerminalFocus } from "./hooks/use-terminal-focus.js";
import { resolveImageMode } from "./image-view.js";
import { useTheme } from "./hooks/use-theme.js";
import { actionLabel, matchesAction, type KeyLike } from "./keybindings.js";
import { locateMatchRow } from "./search-jump.js";
import { summaryEditorTextRows, type SessionController } from "./session-controller.js";
import { splitGauge, statusLine, type StatusLine } from "./status-line.js";
import { indexToOffset } from "./text-offset.js";

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
  const { width: terminalWidth, height } = useTerminalDimensions();
  const theme = useTheme();
  // The sidebar spans the full height on the right; everything else lays out in `width`.
  const sidebarColumns = controller.sidebar.columns(terminalWidth);
  const width = sidebarColumns > 0 ? terminalWidth - sidebarColumns - 1 : terminalWidth;
  const inputRef = useRef<TextareaRenderable>(null);
  const editorRef = useRef<TextareaRenderable>(null);
  const questionInputRef = useRef<InputRenderable>(null);
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const searchInputRef = useRef<InputRenderable>(null);
  const goalInputRef = useRef<InputRenderable>(null);
  const renderer = useRenderer();
  const terminalFocused = useTerminalFocus();
  const state = controller.state;
  const picker = controller.picker;
  const editor = controller.editor;
  const question = controller.question();
  const questionView = controller.questionView(height, width);
  const goalForm = controller.goalForm;
  const overlayOpen = picker !== undefined || editor !== undefined || question !== undefined || goalForm !== undefined;
  const home = isHome(state.blocks, state.running);
  // The alert sits in the composer's column: the main column, or the narrower home composer.
  const alertWidth = home ? homeComposerWidth(width) : width;
  const extras = controller.footerExtras(alertWidth);
  const approval = state.running ? controller.pendingApproval() : undefined;
  const search = controller.search;
  const searching = search.isOpen && !home;
  // Content row of the current match, measured after layout; the transcript marks it.
  const [markRow, setMarkRow] = useState<number>();

  useEffect(() => {
    if (overlayOpen) inputRef.current?.blur();
    else inputRef.current?.focus();
  }, [overlayOpen]);

  // Scroll to the current match once the frame that may have expanded its tool is laid
  // out, then mark its line. Again on resize: rows move when text rewraps.
  useEffect(() => {
    const match = searching ? search.current : undefined;
    if (!match) {
      setMarkRow(undefined);
      return;
    }
    const scroll = scrollRef.current;
    if (!scroll) return;
    const query = search.query;
    let cancelled = false;
    // After the next layout and before it paints: rows are current and the scroll shows in that frame.
    scroll.afterLayout(() => {
      const row = cancelled ? undefined : locateMatchRow(scroll, match, query);
      if (row === undefined) return;
      // A third of the way down, so the lines before the match show too.
      scroll.scrollTo(Math.max(0, row - Math.floor(scroll.height / 3)));
      setMarkRow(row);
    });
    renderer.requestRender();
    return () => {
      cancelled = true;
    };
  }, [searching, search, search.jumpVersion, width, renderer]);

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
  }, [controller.composerDraftVersion, controller.composerDraft, overlayOpen, searching]);

  useKeyboard((key: KeyLike) => {
    // An unfocused surface ignores input (Ctrl+C included): it was meant for another pane.
    if (!terminalFocused.current) {
      key.preventDefault?.();
      return;
    }
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
    if (controller.goalForm) {
      handleGoalFormKey(key);
      return;
    }
    // Read overlays live, not from this render: keys typed right after "/"
    // can arrive before React re-renders. Global handlers run before the
    // focused textarea, so preventDefault keeps it from also taking the key
    // (the composer would otherwise submit its leftover text on Enter).
    if (controller.picker) {
      key.preventDefault?.();
      if (matchesAction(key, "togglePalette") && controller.picker.kind === "commands") controller.closePicker();
      else if (matchesAction(key, "paletteClose")) controller.closePicker();
      else if (matchesAction(key, "paletteUp")) controller.movePickerCursor(-1);
      else if (matchesAction(key, "paletteDown")) controller.movePickerCursor(1);
      else if (matchesAction(key, "paletteSelect")) controller.selectPickerItem();
      else if (controller.picker.kind === "session" && matchesAction(key, "sessionBranch")) controller.branchPickerItem();
      else if (matchesAction(key, "paletteBackspace")) controller.setPickerQuery(controller.pickerQuery.slice(0, -1));
      else if (!key.ctrl && !key.meta && key.name.length === 1) controller.setPickerQuery(controller.pickerQuery + key.name);
      return;
    }
    if (matchesAction(key, "toggleSidebar")) {
      key.preventDefault?.();
      controller.sidebar.toggle();
      return;
    }
    if (handleSearchKey(key)) return;
    if (matchesAction(key, "searchOpen")) {
      key.preventDefault?.();
      controller.openSearch();
      return;
    }
    if (handleMentionKey(key)) return;
    if (handleComposerShortcut(key)) return;
    if (handleTranscriptKey(key)) return;
    if (handleHistoryKey(key)) return;
    if (approval && matchesAction(key, "approve")) controller.resolvePendingApproval(true);
    else if (approval && matchesAction(key, "deny")) controller.resolvePendingApproval(false);
    else if (matchesAction(key, "abort")) controller.abort();
  });

  /**
   * While the search bar is open it takes every key: its own (older, newer, close),
   * transcript scrolling and toggles, and approvals pass; anything else types into
   * the field. Esc closes the bar and never aborts the run.
   */
  function handleSearchKey(key: KeyLike): boolean {
    if (!controller.search.isOpen) return false;
    if (matchesAction(key, "searchClose")) controller.search.close();
    else if (matchesAction(key, "searchNewer")) controller.search.newer();
    else if (matchesAction(key, "searchOlder")) controller.search.older();
    else if (matchesAction(key, "searchOpen")) searchInputRef.current?.focus();
    else if (handleTranscriptKey(key)) return true;
    else if (approval && matchesAction(key, "approve")) controller.resolvePendingApproval(true);
    else if (approval && matchesAction(key, "deny")) controller.resolvePendingApproval(false);
    else return true;
    key.preventDefault?.();
    return true;
  }

  /**
   * The open `@` list takes Up/Down/Enter/Tab/Esc before history, submit, and
   * abort. Enter with nothing to pick (an empty list) still submits. True when
   * the key was used.
   */
  function handleMentionKey(key: KeyLike): boolean {
    if (!controller.mention) return false;
    if (matchesAction(key, "mentionUp")) controller.mentions.move(-1);
    else if (matchesAction(key, "mentionDown")) controller.mentions.move(1);
    else if (matchesAction(key, "mentionClose")) controller.mentions.dismiss();
    else if (matchesAction(key, "mentionSelect")) {
      const picked = controller.mentions.accept();
      const input = inputRef.current;
      if (!picked || !input) return false;
      input.setText(picked.text);
      input.cursorOffset = indexToOffset(picked.text, picked.cursor);
    } else return false;
    key.preventDefault?.();
    return true;
  }

  /**
   * Ctrl+V (clipboard image, else clipboard text), Ctrl+X (clear images, only
   * when there are some), Ctrl+P (palette), Tab / Ctrl+I (modes). True when the
   * key was used.
   */
  function handleComposerShortcut(key: KeyLike): boolean {
    if (matchesAction(key, "pasteClipboard")) {
      const text = controller.pasteClipboard();
      if (text) inputRef.current?.insertText(text.replace(/\r\n?/g, "\n"));
    } else if (matchesAction(key, "clearAttachments")) {
      if (!controller.clearAttachments()) return false;
    } else if (matchesAction(key, "togglePalette")) controller.togglePalette();
    else if (matchesAction(key, "openModes")) controller.openModesPicker();
    else return false;
    key.preventDefault?.();
    return true;
  }

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

  /**
   * Up/Down move between the composer's wrapped lines; only when the cursor
   * cannot move further do they recall sent messages (legacy order). True when
   * the key was used.
   */
  function handleHistoryKey(key: KeyLike): boolean {
    const direction = matchesAction(key, "composerHistoryPrev") ? "up" : matchesAction(key, "composerHistoryNext") ? "down" : undefined;
    const input = inputRef.current;
    if (!direction || !input) return false;
    key.preventDefault?.();
    // moveCursorUp/Down return true even on the first/last row (OpenTUI 0.9.2),
    // so compare the cursor offset to tell whether it actually moved.
    const before = input.cursorOffset;
    if (direction === "up") input.moveCursorUp();
    else input.moveCursorDown();
    if (input.cursorOffset !== before) return true;
    const text = controller.recallPrompt(direction, input.plainText);
    if (text !== undefined) {
      input.setText(text);
      input.gotoBufferEnd();
    }
    return true;
  }

  /** The `/goal` form's keys; anything else edits the selected field's input. */
  function handleGoalFormKey(key: KeyLike): void {
    if (matchesAction(key, "goalFormSubmit")) controller.submitGoalForm();
    else if (matchesAction(key, "goalFormCancel")) controller.closeGoalForm();
    else if (matchesAction(key, "goalFormPrev")) controller.moveGoalField(-1);
    else if (matchesAction(key, "goalFormNext")) controller.moveGoalField(1);
    else if (matchesAction(key, "goalFormEnter")) controller.goalFormEnter();
    else return;
    key.preventDefault?.();
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
    // Now, not when the textarea reports the change: an overlay opening first would keep the sent text as a draft.
    controller.setComposerText("");
    controller.setComposerLines(1);
    controller.submit(text);
  };

  // One row under the composer; paddingLeft takes a cell, the right edge keeps one free.
  const status = statusLine(state, Math.max(0, width - 2));

  const composer = (
    <Composer
      inputRef={inputRef}
      lines={controller.composerLines}
      placeholder={state.running ? "Send a follow-up to the running turn" : "Ask CrewCoder"}
      onLines={(lines) => controller.setComposerLines(lines)}
      onText={(text) => controller.setComposerText(text)}
      onSlash={() => controller.openCommandPalette()}
      onCursor={(text, cursor) => controller.mentions.update(text, cursor)}
      onSubmit={submit}
    />
  );
  const mentionList = controller.mention ? <MentionList mention={controller.mention} /> : null;
  const attachmentRow = state.attachments.length > 0 ? <AttachmentRow attachments={state.attachments} /> : null;

  const alert = controller.currentAlert
    ? <Alert variant={controller.currentAlert.variant} view={alertView(controller.currentAlert, alertWidth)} />
    : null;

  // Overlays replace the footer (and the welcome screen); the transcript stays above them.
  const view = controller.pickerView(height);
  const overlay = editor ? (
    <SummaryEditor editor={editor} editorRef={editorRef} textRows={summaryEditorTextRows(height)} />
  ) : question && questionView ? (
    <ExtensionQuestion block={question} view={questionView} inputRef={questionInputRef} onChoose={(choice) => controller.chooseQuestion(choice)} />
  ) : goalForm ? (
    <GoalForm
      form={goalForm}
      maker={`${state.provider}/${state.model}`}
      inputRef={goalInputRef}
      onInput={(value) => controller.editGoalField(value)}
      onSelect={(index) => controller.selectGoalField(index)}
    />
  ) : picker && view ? (
    <box width="100%" alignItems="center" flexShrink={0}>
      <box width={Math.max(1, Math.min(width - 2, 80))} flexShrink={0}>
        <CommandPalette
          view={view}
          query={controller.pickerQuery}
          title={picker.title}
          placeholder={picker.placeholder}
          emptyText={picker.loading ? "Loading…" : picker.emptyText}
          hint={picker.hint}
        />
      </box>
    </box>
  ) : null;

  const sidebar = sidebarColumns > 0 ? (
    <Sidebar
      state={state}
      tasks={controller.sidebar.tasks}
      width={sidebarColumns}
      height={height}
      home={state.remoteTarget ? undefined : os.homedir()}
      onDividerDrag={(x) => controller.sidebar.resize(terminalWidth - x - 1, terminalWidth)}
    />
  ) : null;

  const last = state.blocks.at(-1);
  const main = home ? (
    <box width={width} height="100%" justifyContent="center" flexShrink={0}>
      {overlay ?? (
        <Home
          width={width}
          height={height}
          info={homeInfo(state.provider, state.model, state.cwd, state.remoteTarget, width)}
          composer={<>{attachmentRow}{composer}{mentionList}</>}
          alert={alert}
          extraRows={(extras.alertRows ?? 0) + (extras.mentionRows ?? 0) + (extras.attachmentRows ?? 0) + (extras.composerRows ?? COMPOSER_ROWS) - COMPOSER_ROWS}
        />
      )}
    </box>
  ) : (
    <box flexDirection="column" width={width} height="100%" flexShrink={0}>
      <Transcript
        blocks={state.blocks}
        running={state.running}
        cwd={state.cwd}
        expansion={controller.toolExpansion}
        // Columns inside the transcript: its padding (1 + 1) and the scrollbar.
        images={{ mode: resolveImageMode(process.env, Boolean(state.remoteTarget)), cols: width - TRANSCRIPT_CHROME_COLUMNS, screenRows: height }}
        scrollRef={scrollRef}
        markRow={searching ? markRow : undefined}
        renderers={state.rendererHooks}
      />
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
            {searching ? (
              <SearchBar search={search} width={width} inputRef={searchInputRef} onQuery={(query) => search.setQuery(query)} />
            ) : (
              <>
                {attachmentRow}
                {composer}
                {mentionList}
              </>
            )}
            <StatusRow status={status} />
          </>
        )}
      </box>
    </box>
  );

  return (
    <box flexDirection="row" width="100%" height="100%" backgroundColor={theme.colors.background}>
      {main}
      {sidebar}
    </box>
  );
}

/**
 * Access, mode, model, and session on the left; context usage and cost pinned
 * right. Full Access reads in the warning color: it skips approvals.
 */
function StatusRow({ status }: { status: StatusLine }): ReactNode {
  const theme = useTheme();
  const { gauge, rest: usage } = splitGauge(status.right);
  return (
    <box flexDirection="row" height={1} flexShrink={0} paddingLeft={1} paddingRight={1}>
      <text height={1} wrapMode="none" flexGrow={1} flexShrink={1}>
        <span fg={status.access === "Full Access" ? theme.colors.warning : theme.colors.success}>{status.access}</span>
        <span fg={theme.colors.mutedForeground}>{status.left}</span>
      </text>
      {status.right ? (
        <text height={1} wrapMode="none" flexShrink={0}>
          {gauge ? <span fg={theme.colors.accent}>{gauge}</span> : null}
          <span fg={theme.colors.mutedForeground}>{usage}</span>
        </text>
      ) : null}
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
const TRANSCRIPT_CHROME_COLUMNS = 3;

function homeInfo(provider: string, model: string, cwd: string, remoteTarget: string | undefined, width: number): string {
  const prefix = `${provider} · ${model} · `;
  const location = remoteTarget ? `${remoteTarget}:${cwd}` : cwd;
  const room = Math.max(8, width - 2 - prefix.length);
  return `${prefix}${shortenPath(location, room, remoteTarget ? undefined : os.homedir())}`;
}
