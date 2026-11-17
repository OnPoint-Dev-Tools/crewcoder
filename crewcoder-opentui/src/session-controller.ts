import type {
  CrewCoderEventHandler,
  CrewCoderProcessOptions,
  CrewCoderResumeOptions,
  SessionRecord
} from "@onpoint-dev-tools/crewcoder-tui-core/bridge/crewcoder-process";
import type { CrewCoderJsonEvent } from "@onpoint-dev-tools/crewcoder-tui-core/bridge/event-parser";
import { applyCrewCoderEvent } from "@onpoint-dev-tools/crewcoder-tui-core/state/event-reducer";
import { createInitialState, normalizeTuiMode, type TuiEventBlock, type TuiState } from "@onpoint-dev-tools/crewcoder-tui-core/state/tui-store";
import { alertRows, type FooterAlert } from "./alert-model.js";
import { CommandRunner, type CommandHost, type SummaryEditorState } from "./command-runner.js";
import { DRAFT_PREFIX, paletteCommands } from "./commands.js";
import { errorMessage, processCli, type CrewCoderCli, type LoadedSkill } from "./crewcoder-cli.js";
import { composerRows, type FooterExtras } from "./footer-layout.js";
import { pickerEntries, pickerHeight, pickerMaxRows, pickerView, type PaletteCommand, type PickerView } from "./palette-model.js";
import { PickerFlows } from "./picker-flows.js";
import { PICKER_COMMANDS, type Picker } from "./pickers.js";
import { choiceAnswer, questionChoices, questionContentWidth, questionMaxRows, questionView, type QuestionAnswer, type QuestionBlock, type QuestionView } from "./question-model.js";

/** The subset of `CrewCoderProcessBridge` the OpenTUI shell drives. */
export type SessionBridge = {
  readonly running: boolean;
  run(options: CrewCoderProcessOptions, onEvent: CrewCoderEventHandler): () => void;
  resume(options: CrewCoderResumeOptions, onEvent: CrewCoderEventHandler): () => void;
  followUp(message: string): boolean;
  resolveApproval(approvalId: string, approved: boolean, reason?: string): boolean;
  requestCompactionPreview(): boolean;
  resolveCompactionPreview(previewId: string, approved: boolean, summary?: string): boolean;
  resolveUiRequest(requestId: string, value: QuestionAnswer): boolean;
  stop(): void;
};

type PendingApproval = Extract<TuiEventBlock, { type: "approval" }>;

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
  /** Visual (wrapped) lines in the composer, reported by App; sizes the footer. */
  composerLines = 1;
  /** Shown above the composer until the next keypress or command. */
  currentAlert: FooterAlert | undefined;
  /** The compaction summary being edited, if any. */
  editor: SummaryEditorState | undefined;
  /** Clears the terminal screen and scrollback (`/clear`); wired by cli.tsx to the renderer. */
  onClearScreen: (() => void) | undefined;
  /** Latest composer text, so a draft survives an overlay that unmounts the composer. */
  private composerText = "";
  /** Cursor and scroll for the open question; reset when another request opens. */
  private questionNav = { requestId: "", cursor: 0, offset: 0 };

  constructor(bridge: SessionBridge, state: TuiState = createInitialState(), cli: CrewCoderCli = processCli) {
    this.bridge = bridge;
    this.state = state;
    this.cli = cli;
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

  get bridgeRunning(): boolean {
    return this.bridge.running;
  }

  // ── Pickers ────────────────────────────────────────────────────────────────

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
    this.picker = undefined;
    this.pickerQuery = "";
    this.pickerCursor = 0;
    this.notify();
  }

  setPickerQuery(query: string): void {
    if (!this.picker) return;
    this.pickerQuery = query;
    this.pickerCursor = 0;
    this.notify();
  }

  movePickerCursor(delta: number): void {
    if (!this.picker) return;
    const count = pickerEntries(this.picker.items, this.pickerQuery).length;
    this.pickerCursor = Math.max(0, Math.min(Math.max(0, count - 1), this.pickerCursor + delta));
    this.notify();
  }

  /** Apply the highlighted item. Async choices report failures as error alerts. */
  selectPickerItem(): void {
    const picker = this.picker;
    if (!picker) return;
    const item = pickerEntries(picker.items, this.pickerQuery)[this.pickerCursor];
    if (!item) return;
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

  pickerView(terminalHeight: number): PickerView | undefined {
    return this.picker ? pickerView(this.picker.items, this.pickerQuery, this.pickerCursor, pickerMaxRows(terminalHeight)) : undefined;
  }

  /**
   * Everything outside the transcript that sizes the footer. Shared by App and
   * the footer sizer. Overlays take the whole footer: the summary editor and a
   * question gate a live run, so they win over a picker.
   */
  footerExtras(terminalHeight: number, terminalWidth: number): FooterExtras {
    const question = this.questionView(terminalHeight, terminalWidth);
    const view = this.pickerView(terminalHeight);
    const overlayRows = this.editor ? summaryEditorTextRows(terminalHeight) + 3 : question ? question.height : view ? pickerHeight(view) : 0;
    return { overlayRows, alertRows: alertRows(this.currentAlert), composerRows: composerRows(this.composerLines) };
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
    this.state.blocks = [];
    this.currentAlert = undefined;
    this.onClearScreen?.();
    this.notify();
  }

  // ── Session ────────────────────────────────────────────────────────────────

  /** Start, resume, or queue a follow-up for the active run. */
  submit(input: string): void {
    const text = input.trim();
    if (!text) return;
    if (text.startsWith("/")) {
      this.runCommand(text);
      this.notify();
      return;
    }
    if (this.bridge.running) {
      if (!this.queueFollowUp(text)) this.alert({ variant: "error", title: "Could not queue the follow-up for the active run" });
      return;
    }
    this.startRun(text);
  }

  startPrompt(text: string): void {
    this.startRun(text);
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
    const state = this.state;
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
    this.bridge.stop();
    this.listeners.clear();
  }

  private readonly onEvent = (event: CrewCoderJsonEvent): void => {
    const questionOpen = this.question() !== undefined;
    applyCrewCoderEvent(this.state, event);
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
    this.state.blocks.push({ type: "user", text });
    this.state.running = true;
    const prompt = this.withPendingSkills(text);
    this.notify();
    if (this.state.sessionId && this.state.sessionId !== "new") {
      this.bridge.resume({ ...this.runOptions(), prompt, sessionId: this.state.sessionId }, this.onEvent);
      return;
    }
    this.bridge.run({ ...this.runOptions(), prompt }, this.onEvent);
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

  private newSession(): void {
    this.bridge.stop();
    this.state.sessionId = "new";
    this.state.blocks = [];
    this.state.running = false;
    this.state.changedFiles = [];
    this.state.checkpoints = [];
    this.state.usage = { turns: 0 };
    this.state.externalDirectories = [];
    this.state.tokenBudget = undefined;
    this.state.fullAccess = false;
    this.pendingSkills = [];
    this.editor = undefined;
    this.currentAlert = undefined;
  }

  private notify(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }
}
