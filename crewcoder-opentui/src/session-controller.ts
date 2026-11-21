import {
  isCrewCoderRemote,
  type CrewCoderCrewOptions,
  type CrewCoderCrewTarget,
  type CrewCoderEventHandler,
  type CrewCoderProcessOptions,
  type CrewCoderResumeOptions,
  type SessionRecord
} from "@onpoint-dev-tools/crewcoder-tui-core/bridge/crewcoder-process";
import type { CrewCoderJsonEvent } from "@onpoint-dev-tools/crewcoder-tui-core/bridge/event-parser";
import { applyCrewCoderEvent, stopCrew } from "@onpoint-dev-tools/crewcoder-tui-core/state/event-reducer";
import { readCrewTaskSnapshot } from "@onpoint-dev-tools/crewcoder-tui-core/state/crew-tasks";
import { createInitialState, normalizeTuiMode, type TuiEventBlock, type TuiState } from "@onpoint-dev-tools/crewcoder-tui-core/state/tui-store";
import { SidebarController, type TaskReader } from "./sidebar.js";
import { IDLE_RECALL, sentMessages, stepRecall, type HistoryRecall } from "./prompt-history.js";
import { attachImagePaths, pasteFromClipboard, systemClipboard, type ClipboardSource } from "./attachments.js";
import { actionLabel } from "./keybindings.js";
import { listPathSuggestions, mentionRows, type PathLister } from "./path-suggestions.js";
import { Mentions, type MentionState } from "./mentions.js";
import { alertRows, type FooterAlert } from "./alert-model.js";
import { CommandRunner, type CommandHost, type SummaryEditorState } from "./command-runner.js";
import { DRAFT_PREFIX, paletteCommands } from "./commands.js";
import { errorMessage, processCli, type CrewCoderCli, type LoadedSkill } from "./crewcoder-cli.js";
import { composerRows, type FooterExtras } from "./footer-layout.js";
import { computeLineAnchors, readLocalFile, type FileReader } from "./diff-anchors.js";
import type { TerminalRun } from "./hunk.js";
import type { LineAnchors } from "./tool-diff.js";
import { pickerEntries, pickerMaxRows, pickerView, type PaletteCommand, type PickerView } from "./palette-model.js";
import { PickerFlows } from "./picker-flows.js";
import { PICKER_COMMANDS, type Picker } from "./pickers.js";
import { TranscriptSearch } from "./search-controller.js";
import { ThemeController } from "./theme-controller.js";
import { handoffEnv, removeCrewHandoff, tmuxAttachHint, writeCrewHandoff, type TmuxLauncher } from "./tmux.js";
import type { ToolExpansion } from "./transcript.js";
import { choiceAnswer, questionChoices, questionContentWidth, questionMaxRows, questionView, type QuestionAnswer, type QuestionBlock, type QuestionView } from "./question-model.js";

/** The subset of `CrewCoderProcessBridge` the OpenTUI shell drives. */
export type SessionBridge = {
  readonly running: boolean;
  run(options: CrewCoderProcessOptions, onEvent: CrewCoderEventHandler): () => void;
  resume(options: CrewCoderResumeOptions, onEvent: CrewCoderEventHandler): () => void;
  crew(options: CrewCoderCrewOptions, onEvent: CrewCoderEventHandler): () => void;
  followUp(message: string): boolean;
  resolveApproval(approvalId: string, approved: boolean, reason?: string): boolean;
  requestCompactionPreview(): boolean;
  resolveCompactionPreview(previewId: string, approved: boolean, summary?: string): boolean;
  resolveUiRequest(requestId: string, value: QuestionAnswer): boolean;
  stop(): void;
};

type PendingApproval = Extract<TuiEventBlock, { type: "approval" }>;
type PendingCrew = { target: CrewCoderCrewTarget; task: string; command: string };

const CREW_IN_TMUX = "tmux";
const CREW_HERE = "here";

/** `planner + builder` or `team feature`, for the picker title and tmux names. */
function crewLabel(target: CrewCoderCrewTarget): string {
  return target.kind === "team" ? `team ${target.team}` : target.workers.join(" + ");
}
type ToolBlock = Extract<TuiEventBlock, { type: "tool" }>;

/** Summary editor text rows for a terminal height (the editor adds border + hint). */
export function summaryEditorTextRows(terminalHeight: number): number {
  return Math.max(3, Math.min(14, terminalHeight - 5));
}

/**
 * Owns the shared TUI state and the agent bridge for one terminal session.
 * React subscribes through `subscribe`/`getVersion`; the reducer mutates
 * `state` in place, so every change bumps `version` to trigger a render.
 */
export class SessionController implements CommandHost {
  readonly state: TuiState;
  readonly cli: CrewCoderCli;
  private readonly bridge: SessionBridge;
  private readonly flows: PickerFlows;
  private readonly commands: CommandRunner;
  private readonly listeners = new Set<() => void>();
  private version = 0;
  private pendingSkills: LoadedSkill[] = [];
  /** The open palette or picker; at most one at a time. */
  picker: Picker | undefined;
  pickerQuery = "";
  /** Index into `pickerEntries(picker.items, pickerQuery)`. */
  pickerCursor = 0;
  /** Text a picker wants in the composer; App applies it when `composerDraftVersion` changes. */
  composerDraft = "";
  composerDraftVersion = 0;
  private historyRecall: HistoryRecall = IDLE_RECALL;
  /** Visual (wrapped) lines in the composer, reported by App; sizes the footer. */
  composerLines = 1;
  /** Shown above the composer until the next keypress or command. */
  currentAlert: FooterAlert | undefined;
  /** The compaction summary being edited, if any. */
  editor: SummaryEditorState | undefined;
  /** Hands the terminal to a full-screen program such as Hunk (`/diff`); wired by cli.tsx. */
  runInTerminal: TerminalRun | undefined;
  /** `/repaint`: redraws every cell, discarding whatever else wrote to the terminal; wired by cli.tsx. */
  repaint: (() => void) | undefined;
  /** `/quit`: the same exit as Ctrl+C; wired by cli.tsx. */
  quit: (() => void) | undefined;
  /**
   * Crews in tmux (`docs/CREWS.md#tmux`): the launcher and the command that starts a
   * second UI on a handoff file. Wired by cli.tsx only when tmux is installed and the
   * workspace is local; undefined means /crew and /team run here without asking.
   */
  crewTmux: { launcher: TmuxLauncher; command(handoffFile: string): string[] } | undefined;
  /** A /crew or /team waiting for the "here or tmux" choice. */
  private pendingCrew: PendingCrew | undefined;
  /** Ctrl+O: every tool's output expanded. A per-tool toggle flips its own state against this. */
  private allToolsExpanded = false;
  /** Tools toggled individually. Keyed by identity: the reducer mutates blocks in place. */
  private toggledTools = new WeakSet<ToolBlock>();
  /** Ctrl+T: every edit's diff hidden. A per-tool toggle flips its own diff against this. */
  private allDiffsHidden = false;
  private toggledDiffs = new WeakSet<ToolBlock>();
  private readonly anchors = new WeakMap<ToolBlock, LineAnchors>();
  private readonly readFile: FileReader;
  /** Latest composer text, so a draft survives an overlay that unmounts the composer. */
  private composerText = "";
  /** Cursor and scroll for the open question; reset when another request opens. */
  private questionNav = { requestId: "", cursor: 0, offset: 0 };
  /** `@` path suggestions under the composer (`mentions.ts`). */
  readonly mentions: Mentions;
  private readonly clipboard: ClipboardSource;
  /** The right sidebar (Ctrl+B, `/sidebar`): open state, width, crew tasks. */
  readonly sidebar: SidebarController;
  /** The active theme and `/theme` (preview, apply, saved pick); configured by cli.tsx. */
  readonly themes: ThemeController;
  /** Transcript search (Ctrl+F, `/find`); App scrolls to its current match. */
  readonly search: TranscriptSearch;

  constructor(
    bridge: SessionBridge,
    state: TuiState = createInitialState(),
    cli: CrewCoderCli = processCli,
    readFile: FileReader = readLocalFile,
    // null, not undefined: an explicit undefined would take this default.
    listPaths: PathLister | null = isCrewCoderRemote() ? null : listPathSuggestions,
    clipboard: ClipboardSource = systemClipboard,
    // The task store lives on the workspace's disk; remote workspaces are not local.
    readTasks: TaskReader | null = isCrewCoderRemote() ? null : readCrewTaskSnapshot
  ) {
    this.sidebar = new SidebarController(this, readTasks);
    this.themes = new ThemeController(this);
    this.search = new TranscriptSearch(this);
    this.clipboard = clipboard;
    this.bridge = bridge;
    this.state = state;
    this.cli = cli;
    this.readFile = readFile;
    this.mentions = new Mentions(listPaths, {
      cwd: () => this.state.cwd,
      changed: () => this.notify(),
      failed: (error) => this.alert({ variant: "error", title: "Could not list workspace paths", body: errorMessage(error) })
    });
    this.flows = new PickerFlows(this);
    this.commands = new CommandRunner(this, this.flows);
    // The legacy help tip refers to slash commands this preview does not ship yet.
    this.state.blocks = [];
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  /** The open `@` list, when the composer cursor is in an `@token`. */
  get mention(): MentionState | undefined {
    return this.mentions.current;
  }

  get bridgeRunning(): boolean {
    return this.bridge.running;
  }

  // ── Pickers ────────────────────────────────────────────────────────────────

  /** Ctrl+P: open the command palette, or close it when open. The composer draft survives. */
  togglePalette(): void {
    if (this.picker?.kind === "commands") return this.closePicker();
    this.preserveComposerDraft();
    this.openCommandPalette();
  }

  /** Tab / Ctrl+I: the modes and saved workers picker (the legacy agents overlay). */
  openModesPicker(): void {
    this.preserveComposerDraft();
    this.flows.open("mode");
  }

  openCommandPalette(): void {
    this.openPicker({ kind: "commands", placeholder: "Search commands…", emptyText: "No commands found", items: paletteCommands(this.state.integrationProfile), loading: false });
  }

  /** A small picker whose items are commands or `draft:` texts (see commands.ts). */
  openMenu(title: string, items: PaletteCommand[], load?: () => Promise<PaletteCommand[]>): void {
    const menu: Picker = { kind: "menu", title, placeholder: "Search…", emptyText: "Nothing to pick", items, loading: load !== undefined };
    if (load) this.flows.load(menu, load);
    else this.openPicker(menu);
  }

  /** Show a picker. Replacing a loading picker of the same kind keeps the query and a moved cursor. */
  openPicker(next: Picker): void {
    if (this.picker?.kind === "theme" && next.kind !== "theme") this.themes.endPreview();
    const refresh = this.picker?.kind === next.kind && this.picker.loading;
    if (!refresh) this.pickerQuery = "";
    if (!refresh || this.pickerCursor === 0) {
      const current = pickerEntries(next.items, this.pickerQuery).findIndex((item) => item.current);
      this.pickerCursor = Math.max(0, current);
    }
    this.picker = next;
    this.notify();
  }

  closePicker(): void {
    if (!this.picker) return;
    // Esc on "where should the crew run" cancels the crew.
    if (this.picker.kind === "crewLaunch") this.pendingCrew = undefined;
    // Leaving /theme without Enter keeps the applied theme (a no-op after Enter applied one).
    if (this.picker.kind === "theme") this.themes.endPreview();
    this.picker = undefined;
    this.pickerQuery = "";
    this.pickerCursor = 0;
    this.notify();
  }

  setPickerQuery(query: string): void {
    if (!this.picker) return;
    this.pickerQuery = query;
    this.pickerCursor = 0;
    this.previewHighlightedTheme();
    this.notify();
  }

  movePickerCursor(delta: number): void {
    if (!this.picker) return;
    const count = pickerEntries(this.picker.items, this.pickerQuery).length;
    this.pickerCursor = Math.max(0, Math.min(Math.max(0, count - 1), this.pickerCursor + delta));
    this.previewHighlightedTheme();
    this.notify();
  }

  /** In /theme the highlighted theme is shown live; Esc returns to the applied one. */
  private previewHighlightedTheme(): void {
    if (this.picker?.kind !== "theme") return;
    this.themes.preview(pickerEntries(this.picker.items, this.pickerQuery)[this.pickerCursor]?.id);
  }

  /** Apply the highlighted item. Async choices report failures as error alerts. */
  selectPickerItem(): void {
    const picker = this.picker;
    if (!picker) return;
    const item = pickerEntries(picker.items, this.pickerQuery)[this.pickerCursor];
    if (!item) return;
    if (picker.kind === "theme") {
      // Applied synchronously before closing, so the old theme never flashes back for a frame.
      const applied = this.flows.select("theme", item.id);
      this.closePicker();
      applied.then(
        () => this.notify(),
        (error: unknown) => this.alert({ variant: "error", title: `Could not apply theme ${item.id}`, body: errorMessage(error) })
      );
      return;
    }
    if (picker.kind === "crewLaunch") {
      const pending = this.pendingCrew;
      this.closePicker();
      if (!pending) return;
      if (item.id === CREW_IN_TMUX) void this.runCrewInTmux(pending);
      else this.startCrew(pending.target, pending.task, pending.command);
      return;
    }
    this.closePicker();
    if (picker.kind === "commands" || picker.kind === "menu") {
      if (item.id.startsWith(DRAFT_PREFIX)) this.setComposerDraft(item.id.slice(DRAFT_PREFIX.length));
      else this.submit(item.id);
      return;
    }
    this.flows.select(picker.kind, item.id).then(
      () => this.notify(),
      (error: unknown) => this.alert({ variant: "error", title: "Could not apply that choice", body: errorMessage(error) })
    );
  }

  /** Tab in /sessions: branch the highlighted session and open the branch. */
  branchPickerItem(): void {
    const picker = this.picker;
    if (picker?.kind !== "session" || picker.loading) return;
    const item = pickerEntries(picker.items, this.pickerQuery)[this.pickerCursor];
    if (!item) return;
    this.closePicker();
    this.flows.branch(item.id).then(
      () => this.notify(),
      (error: unknown) => this.alert({ variant: "error", title: "Could not branch the session", body: errorMessage(error) })
    );
  }

  pickerView(terminalHeight: number): PickerView | undefined {
    return this.picker ? pickerView(this.picker.items, this.pickerQuery, this.pickerCursor, pickerMaxRows(terminalHeight)) : undefined;
  }

  /** Rows the alert and composer take; the welcome screen hides the logo when they do not fit. */
  footerExtras(): FooterExtras {
    return {
      alertRows: alertRows(this.currentAlert),
      composerRows: composerRows(this.composerLines),
      mentionRows: this.mention ? mentionRows(this.mention.items.length) : 0,
      attachmentRows: this.state.attachments.length > 0 ? 1 : 0
    };
  }

  // ── Image attachments ────────────────────────────────────────────────────────────

  /**
   * Ctrl+V: attach a clipboard image (or image files the clipboard text names)
   * and return undefined, or return clipboard text for the composer. Remote
   * mode attaches nothing: local files cannot reach the SSH host yet.
   */
  pasteClipboard(): string | undefined {
    if (isCrewCoderRemote()) {
      const text = this.clipboard.text();
      if (!text && this.clipboard.image()) this.alert({ variant: "warning", title: "Images are not available in remote SSH mode" });
      return text;
    }
    let result: ReturnType<typeof pasteFromClipboard>;
    try {
      result = pasteFromClipboard(this.clipboard, this.state.attachments);
    } catch (error) {
      this.alert({ variant: "error", title: "Could not attach the clipboard image", body: errorMessage(error) });
      return undefined;
    }
    if (result.attached.length > 0) {
      this.state.attachments = [...this.state.attachments, ...result.attached];
      this.notify();
    }
    return result.text;
  }

  /** Ctrl+X: drop the pending images; false when there were none. */
  clearAttachments(): boolean {
    if (this.state.attachments.length === 0) return false;
    this.state.attachments = [];
    this.notify();
    return true;
  }

  // ── Tool output ───────────────────────────────────────────────────────────────

  readonly toolExpansion: ToolExpansion = {
    isExpanded: (block) => this.allToolsExpanded !== this.toggledTools.has(block),
    toggle: (block) => this.flip(this.toggledTools, block),
    isDiffShown: (block) => this.allDiffsHidden === this.toggledDiffs.has(block),
    toggleDiff: (block) => this.flip(this.toggledDiffs, block),
    lineAnchors: (block) => this.anchors.get(block)
  };

  /**
   * Number a finished edit's diff with real file lines, read once from the
   * local workspace (remote files are not readable here; those diffs stay plain).
   */
  private anchorEdit(toolCallId: unknown): void {
    {
        if (typeof toolCallId !== "string" || isCrewCoderRemote()) return;
        const block = this.state.blocks.find((candidate): candidate is ToolBlock => candidate.type === "tool" && candidate.id === toolCallId);
        // The agent's snapshot diffs (file_diff, before tool_execution_end) already carry real line numbers.
        if (!block || block.fileDiffs?.length) return;
        computeLineAnchors(block, this.state.cwd, this.readFile).then((anchors) => {
          if (!anchors) return;
          this.anchors.set(block, anchors);
          this.notify();
        }, () => undefined);
      }
  }

  /**
   * Ctrl+F / `/find [text]`: search the transcript. The bar takes the composer's
   * place, so the draft is kept; there is nothing to search on the welcome screen.
   */
  openSearch(query = ""): void {
    if (this.state.blocks.length === 0) return this.alert({ variant: "info", title: "Nothing to search yet" });
    this.preserveComposerDraft();
    this.search.open(query);
  }

  /** Hide or show every edit's diff, resetting per-tool diff toggles. */
  toggleAllDiffs(): void {
    this.allDiffsHidden = !this.allDiffsHidden;
    this.toggledDiffs = new WeakSet();
    this.notify();
  }

  private flip(set: WeakSet<ToolBlock>, block: ToolBlock): void {
    if (set.has(block)) set.delete(block);
    else set.add(block);
    this.notify();
  }

  /** Expand or collapse every tool's output, resetting individual toggles. */
  toggleAllToolOutput(): void {
    this.allToolsExpanded = !this.allToolsExpanded;
    this.toggledTools = new WeakSet();
    this.notify();
  }

  // ── Extension questions ────────────────────────────────────────────────────

  /**
   * The extension question waiting for an answer: the oldest pending
   * `extension_ui` request of the active run. Only a running agent can receive
   * the answer, so none shows once the run is over.
   */
  question(): QuestionBlock | undefined {
    if (!this.bridge.running) return undefined;
    return this.state.blocks.find((block): block is QuestionBlock => block.type === "extension_ui" && block.status === "pending" && block.requestId !== "");
  }

  questionView(terminalHeight: number, terminalWidth: number): QuestionView | undefined {
    const block = this.question();
    if (!block) return undefined;
    const nav = this.navFor(block);
    return questionView(block, questionContentWidth(terminalWidth), questionMaxRows(terminalHeight), nav.cursor, nav.offset);
  }

  /** Move between choices (confirm, select, component), wrapping at either end. */
  moveQuestionCursor(delta: number): void {
    const block = this.question();
    if (!block) return;
    const count = questionChoices(block).length;
    if (count === 0) return;
    const nav = this.navFor(block);
    this.questionNav = { ...nav, cursor: (((nav.cursor + delta) % count) + count) % count };
    this.notify();
  }

  /** Scroll a question that is too long for the card; the view clamps the offset. */
  scrollQuestion(delta: number, terminalHeight: number, terminalWidth: number): void {
    const block = this.question();
    if (!block) return;
    const nav = this.navFor(block);
    const applied = this.questionView(terminalHeight, terminalWidth)?.offset ?? nav.offset;
    this.questionNav = { ...nav, offset: Math.max(0, applied + delta) };
    this.notify();
  }

  /** Answer with the highlighted choice (Enter on confirm, select, or component). */
  submitQuestionChoice(): void {
    const block = this.question();
    if (block) this.answerQuestion(choiceAnswer(block, this.navFor(block).cursor));
  }

  /** Answer with a clicked choice. */
  chooseQuestion(choice: number): void {
    const block = this.question();
    if (block) this.answerQuestion(choiceAnswer(block, choice));
  }

  /**
   * Send the answer over the `ui_response` control channel; `null` cancels.
   * The block is settled locally at once so the card closes; the agent's
   * `extension_ui_resolved` confirms it.
   */
  answerQuestion(value: QuestionAnswer): void {
    const block = this.question();
    if (!block) return;
    if (!this.bridge.resolveUiRequest(block.requestId, value)) {
      this.state.blocks.push({ type: "error", text: "No active CrewCoder run is waiting for this extension question." });
    }
    block.status = value === null ? "cancelled" : "answered";
    if (value !== null) block.answer = typeof value === "boolean" ? (value ? "yes" : "no") : value;
    this.notify();
  }

  private navFor(block: QuestionBlock): { requestId: string; cursor: number; offset: number } {
    return this.questionNav.requestId === block.requestId ? this.questionNav : { requestId: block.requestId, cursor: 0, offset: 0 };
  }

  // ── Alerts, composer, editor ───────────────────────────────────────────────

  alert(alert: FooterAlert): void {
    this.currentAlert = alert;
    this.notify();
  }

  dismissAlert(): void {
    if (!this.currentAlert) return;
    this.currentAlert = undefined;
    this.notify();
  }

  setComposerDraft(text: string): void {
    this.composerDraft = text;
    this.composerDraftVersion += 1;
    this.notify();
  }

  /** The composer's current text; restored as a draft after an overlay closes. */
  setComposerText(text: string): void {
    this.composerText = text;
  }

  /** Keep the composer draft when an overlay that unmounts it opens on its own. */
  private preserveComposerDraft(): void {
    if (this.composerText) this.setComposerDraft(this.composerText);
  }

  /**
   * Up/Down on the composer's first/last line: the text of the older/newer
   * sent message (or the saved draft), or undefined when there is nothing
   * further that way. See `prompt-history.ts`.
   */
  recallPrompt(direction: "up" | "down", current: string): string | undefined {
    const step = stepRecall(this.historyRecall, direction, current, sentMessages(this.state.blocks));
    if (!step) return undefined;
    this.historyRecall = step.recall;
    return step.text;
  }

  setComposerLines(lines: number): void {
    const next = Math.max(1, lines);
    if (next === this.composerLines) return;
    this.composerLines = next;
    this.notify();
  }

  openSummaryEditor(editor: SummaryEditorState): void {
    this.picker = undefined;
    this.editor = editor;
    this.currentAlert = undefined;
    this.notify();
  }

  /** Apply (with the edited text) or cancel the open compaction summary editor. */
  resolveSummary(approved: boolean, summary: string): void {
    const editor = this.editor;
    if (!editor) return;
    this.editor = undefined;
    const context = editor.context;
    if (context.mode === "live") {
      if (!this.bridge.resolveCompactionPreview(context.previewId, approved, approved ? summary : undefined)) {
        this.alert({ variant: "error", title: "No active run is waiting for this compaction preview" });
      } else {
        this.alert(approved ? { variant: "success", title: "Edited summary sent to the running session" } : { variant: "info", title: "Compaction preview cancelled" });
      }
      return;
    }
    if (!approved) {
      this.alert({ variant: "info", title: "Compaction preview cancelled" });
      return;
    }
    this.commands.applyEditedSummary(context.sessionId, summary).then(
      () => this.notify(),
      (error: unknown) => this.alert({ variant: "error", title: "Could not apply the edited summary", body: errorMessage(error) })
    );
  }

  requestLiveCompactionPreview(): boolean {
    return this.bridge.requestCompactionPreview();
  }

  clearScreen(): void {
    this.search.close();
    this.state.blocks = [];
    this.currentAlert = undefined;
    this.notify();
  }

  // ── Session ────────────────────────────────────────────────────────────────

  /** Start, resume, or queue a follow-up for the active run. */
  submit(input: string): void {
    // A sent message ends any recall; the next Up starts from the newest again.
    this.historyRecall = IDLE_RECALL;
    const text = input.trim();
    // A pasted screenshot can be sent on its own.
    if (!text && this.state.attachments.length === 0) return;
    if (text.startsWith("/")) {
      this.runCommand(text);
      this.notify();
      return;
    }
    if (this.bridge.running) {
      // The control channel carries text only; pending images wait for the next prompt.
      if (!text) return this.alert({ variant: "info", title: "Images are sent with the next prompt, after this turn" });
      if (!this.queueFollowUp(text)) this.alert({ variant: "error", title: "Could not queue the follow-up for the active run" });
      return;
    }
    // Image paths in the prompt (a file dropped on the terminal) attach too; the text keeps them.
    if (!isCrewCoderRemote()) this.state.attachments = [...this.state.attachments, ...attachImagePaths(text, this.state.attachments)];
    this.startRun(text);
  }

  startPrompt(text: string): void {
    this.startRun(text);
  }

  /**
   * `/crew` and `/team`. With tmux available (local workspaces), first ask where the
   * crew runs: here (quitting stops it) or in tmux (keeps running after this UI
   * closes). Without tmux it runs here.
   */
  launchCrew(target: CrewCoderCrewTarget, task: string, command: string): void {
    if (this.refuseBusyCrew()) return;
    if (!this.crewTmux || isCrewCoderRemote()) return this.startCrew(target, task, command);
    this.preserveComposerDraft();
    this.pendingCrew = { target, task, command };
    this.openPicker({
      kind: "crewLaunch",
      title: `Where should ${crewLabel(target)} run?`,
      placeholder: "Search…",
      emptyText: "Nothing to pick",
      loading: false,
      items: [
        // Short: picker rows do not wrap.
        { id: CREW_IN_TMUX, label: "Run in tmux", description: "survives closing CrewCoder; attach to approve" },
        { id: CREW_HERE, label: "Run here", description: "quitting CrewCoder stops the crew" }
      ]
    });
  }

  /**
   * Hand the crew to a second UI in tmux. Its settings and `CREWCODER_*` variables go
   * in a private handoff file the new UI reads and deletes (`tmux.ts`).
   */
  private async runCrewInTmux(pending: PendingCrew): Promise<void> {
    const tmux = this.crewTmux;
    if (!tmux || this.refuseBusyCrew()) return;
    const state = this.state;
    let file: string | undefined;
    try {
      file = writeCrewHandoff({
        version: 1, ...pending, cwd: state.cwd, provider: state.provider, model: state.model, effort: state.effort,
        mode: state.mode, systemPrompt: state.systemPrompt, fullAccess: state.fullAccess, env: handoffEnv(process.env)
      });
      const placement = await tmux.launcher.launch(tmux.command(file), state.cwd, crewLabel(pending.target));
      // A record that outlives the next keypress: the attach command is needed later.
      state.blocks.push({ type: "user", text: pending.command });
      state.blocks.push({ type: "system", text: tmuxAttachHint(placement) });
      this.notify();
    } catch (error) {
      if (file) removeCrewHandoff(file);
      this.alert({ variant: "error", title: "Could not start the crew in tmux", body: errorMessage(error) });
    }
  }

  private refuseBusyCrew(): boolean {
    if (!this.bridge.running && !this.state.running) return false;
    this.alert({ variant: "warning", title: "Wait for the current run to finish before starting a crew", body: "Use /stop to end it." });
    return true;
  }

  /**
   * `/crew` and `/team`: stream the crew through the bridge so its roster, each
   * worker's work, and approvals show live. Workers run in their own sessions;
   * this session's id and transcript stay. `command` is what the user typed.
   */
  startCrew(target: CrewCoderCrewTarget, task: string, command: string): void {
    if (this.refuseBusyCrew()) return;
    const state = this.state;
    state.blocks.push({ type: "user", text: command });
    state.running = true;
    // The AGENTS roster lives in the sidebar; a crew is the moment to show it.
    if (!this.sidebar.open) this.sidebar.setOpen(true);
    // The agent's crew commands take no worker, budget, image, or directory options.
    const options: CrewCoderCrewOptions = {
      target,
      prompt: task,
      provider: state.provider,
      mode: state.mode,
      model: state.model,
      systemPrompt: state.systemPrompt,
      effort: state.effort,
      cwd: state.cwd,
      approval: state.fullAccess ? "full-access" : "review"
    };
    try {
      this.bridge.crew(options, this.onEvent);
    } catch (error) {
      state.running = false;
      this.alert({ variant: "error", title: "Could not start the crew", body: errorMessage(error) });
      return;
    }
    this.notify();
  }

  queueFollowUp(text: string): boolean {
    if (!this.bridge.followUp(text)) return false;
    this.state.blocks.push({ type: "user", text, background: ["Queued follow-up for the running turn."] });
    this.notify();
    return true;
  }

  /** Resolve a pending approval (the latest by default) over the live control channel. */
  resolveApproval(approvalId: string | undefined, approved: boolean): void {
    const id = approvalId ?? this.pendingApproval()?.id;
    const verb = approved ? "approve" : "deny";
    if (!id) return this.alert({ variant: "warning", title: `No pending approval to ${verb}` });
    if (!this.bridge.running) return this.alert({ variant: "warning", title: "No active run is waiting for approval" });
    const reason = approved ? "Approved from OpenTUI control channel." : "Denied from OpenTUI control channel.";
    if (!this.bridge.resolveApproval(id, approved, reason)) this.alert({ variant: "error", title: `Could not ${verb} ${id}` });
    this.notify();
  }

  /** The approval card buttons and Ctrl+Y / Ctrl+N. */
  resolvePendingApproval(approved: boolean): boolean {
    const pending = this.pendingApproval();
    if (!pending?.id || !this.bridge.running) return false;
    const reason = approved ? "Approved from OpenTUI control channel." : "Denied from OpenTUI control channel.";
    const resolved = this.bridge.resolveApproval(pending.id, approved, reason);
    if (!resolved) this.state.blocks.push({ type: "error", text: `Could not ${approved ? "approve" : "deny"} ${pending.id}.` });
    this.notify();
    return resolved;
  }

  pendingApproval(): PendingApproval | undefined {
    for (let index = this.state.blocks.length - 1; index >= 0; index--) {
      const block = this.state.blocks[index];
      if (block?.type === "approval" && block.status === "pending") return block;
    }
    return undefined;
  }

  /** Abort the active run. Returns false when nothing was running. */
  abort(): boolean {
    if (!this.bridge.running && !this.state.running) return false;
    this.bridge.stop();
    // A stopped crew sends no crew_end; finish its roster here.
    stopCrew(this.state);
    this.state.running = false;
    this.state.blocks.push({ type: "system", text: "Request aborted." });
    this.notify();
    return true;
  }

  push(block: TuiEventBlock): void {
    this.state.blocks.push(block);
    this.notify();
  }

  changed(): void {
    this.notify();
  }

  attachSkill(skill: LoadedSkill): void {
    if (this.pendingSkills.some((attached) => attached.name === skill.name)) {
      this.alert({ variant: "info", title: `Skill already attached: ${skill.name}`, body: "It goes with your next message." });
      return;
    }
    this.pendingSkills.push(skill);
    this.alert({ variant: "success", title: `Skill attached: ${skill.name}`, body: `Goes with your next message (${this.pendingSkills.length} attached).` });
  }

  /** Load a saved session's history with its provider, model, effort, mode, and directories. */
  resumeSession(session: SessionRecord): void {
    this.bridge.stop();
    this.search.close();
    const state = this.state;
    this.resetCrew();
    state.blocks = [];
    state.changedFiles = [];
    state.systemPrompt = undefined;
    state.worker = undefined;
    if (session.provider) state.provider = session.provider;
    if (session.model) state.model = session.model;
    // A saved level the resumed model rejects (e.g. xhigh) must not ride along.
    state.effort = PickerFlows.resumeEffort(state, session.effort);
    state.externalDirectories = [...(session.externalDirectories ?? [])];
    const mode = session.requestedMode || session.resolvedMode;
    if (mode) state.mode = normalizeTuiMode(mode);
    state.sessionId = session.id;
    state.running = true;
    this.notify();
    this.bridge.resume({ ...this.runOptions(), sessionId: session.id }, this.onEvent);
  }

  dispose(): void {
    this.sidebar.dispose();
    this.bridge.stop();
    this.listeners.clear();
  }

  private readonly onEvent = (event: CrewCoderJsonEvent): void => {
    const questionOpen = this.question() !== undefined;
    applyCrewCoderEvent(this.state, event);
    if (event.type === "tool_execution_end") this.anchorEdit(event.toolCallId);
    // Task tools write the store; a finished run may have moved the branch or dirtied the tree.
    if (this.sidebar.open && (event.type === "tool_execution_end" || event.type === "agent_end")) void this.sidebar.refreshTasks();
    if (event.type === "agent_end") void this.sidebar.refreshGitLabel();
    // An extension question replaces the footer, picker included; keep what the user was typing.
    if (event.type === "extension_ui_request" && !questionOpen && this.question()) {
      this.preserveComposerDraft();
      this.picker = undefined;
      this.pickerQuery = "";
      this.pickerCursor = 0;
    }
    // A live /compact preview: the loop paused for the user to edit the summary.
    if (event.type === "session_compaction_preview" && typeof event.previewId === "string" && typeof event.summary === "string") {
      this.preserveComposerDraft();
      this.openSummaryEditor({
        summary: event.summary,
        context: { mode: "live", previewId: event.previewId },
        source: typeof event.source === "string" ? event.source : undefined,
        originalMessageCount: typeof event.originalMessageCount === "number" ? event.originalMessageCount : undefined,
        retainedMessageCount: typeof event.retainedMessageCount === "number" ? event.retainedMessageCount : undefined
      });
      return;
    }
    this.notify();
  };

  private runOptions(): Omit<CrewCoderProcessOptions, "prompt"> {
    const state = this.state;
    return {
      provider: state.provider,
      mode: state.mode,
      worker: state.worker,
      model: state.model,
      systemPrompt: state.systemPrompt,
      effort: state.effort,
      cwd: state.cwd,
      approval: state.fullAccess ? "full-access" : "review",
      budget: state.tokenBudget,
      externalDirectories: state.externalDirectories
    };
  }

  private startRun(text: string): void {
    const attachments = this.state.attachments;
    if (attachments.length > 0 && isCrewCoderRemote()) {
      this.alert({ variant: "error", title: "Local images cannot be sent in remote SSH mode", body: `Clear them with ${actionLabel("clearAttachments")} and send the prompt again.` });
      return;
    }
    this.state.blocks.push({ type: "user", text: text || "(image attached)" });
    // Each image shows under the user turn; the agent gets the files as --image.
    for (const attachment of attachments) this.state.blocks.push({ type: "image", attachment });
    this.state.attachments = [];
    this.state.running = true;
    const prompt = this.withPendingSkills(text);
    const images = attachments.map((attachment) => attachment.path);
    this.notify();
    if (this.state.sessionId && this.state.sessionId !== "new") {
      this.bridge.resume({ ...this.runOptions(), prompt, images, sessionId: this.state.sessionId }, this.onEvent);
      return;
    }
    this.bridge.run({ ...this.runOptions(), prompt, images }, this.onEvent);
  }

  /** Skills from /skills ride ahead of the next prompt once; the transcript shows only the typed text. */
  private withPendingSkills(prompt: string): string {
    if (!this.pendingSkills.length) return prompt;
    const skills = this.pendingSkills.map((skill) => `# Skill: ${skill.name}\n${skill.description}\n\n${skill.body}`).join("\n\n");
    this.pendingSkills = [];
    return `The user attached the following skill(s). Follow their instructions when relevant to the request below.\n\n${skills}\n\n---\n\n${prompt}`;
  }

  private runCommand(command: string): void {
    const match = /^(\S+)\s*([\s\S]*)$/.exec(command);
    const name = match?.[1] ?? command;
    const rest = match?.[2] ?? "";
    if (name === "/new") return this.newSession();
    if (name === "/stop") {
      if (!this.abort()) this.alert({ variant: "info", title: "Nothing is running" });
      return;
    }
    const kind = Object.hasOwn(PICKER_COMMANDS, name) ? PICKER_COMMANDS[name] : undefined;
    if (kind && rest.trim()) {
      this.flows.applyArgument(kind, rest.trim()).then(
        () => this.notify(),
        (error: unknown) => this.alert({ variant: "error", title: name, body: errorMessage(error) })
      );
      return;
    }
    if (kind) return this.flows.open(kind);
    if (this.commands.run(name, rest)) return;
    this.alert({
      variant: "warning",
      title: `${name} is not available in OpenTUI yet`,
      body: "Use the legacy UI (crewcoder-tui) or the agent CLI for it."
    });
  }

  /** Crews belong to the session they ran from: a stopped one is finished, its workers forgotten. */
  private resetCrew(): void {
    stopCrew(this.state);
    this.state.crewWorkers = [];
    this.state.crewSessionIds = [];
  }

  private newSession(): void {
    this.bridge.stop();
    this.search.close();
    this.resetCrew();
    this.state.sessionId = "new";
    this.state.blocks = [];
    this.state.running = false;
    this.state.changedFiles = [];
    this.state.checkpoints = [];
    this.state.usage = { turns: 0 };
    this.state.externalDirectories = [];
    this.state.tokenBudget = undefined;
    this.state.fullAccess = false;
    this.state.attachments = [];
    this.pendingSkills = [];
    this.editor = undefined;
    this.currentAlert = undefined;
  }

  private notify(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }
}
