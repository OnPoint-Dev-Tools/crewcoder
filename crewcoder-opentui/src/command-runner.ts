import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isCrewCoderRemote, isCrewName, type CrewCoderCrewTarget } from "@onpoint-dev-tools/crewcoder-tui-core/bridge/crewcoder-process";
import {
  formatBudgetTokens, parseBudgetInput, parseCompactionResult, parseDecisionExplanation, parseGoalRecord,
  parseGoalStartInput, parseReviewSummary, tokenizeGoalCommand, type GoalStartInput
} from "@onpoint-dev-tools/crewcoder-tui-core/state/command-results";
import { effortLevelsForModel } from "@onpoint-dev-tools/crewcoder-tui-core/state/effort-levels";
import { normalizeTuiMode, type TuiState } from "@onpoint-dev-tools/crewcoder-tui-core/state/tui-store";
import type { FooterAlert } from "./alert-model.js";
import { cliOutputAlert, goalsAlert, reviewSummaryAlert, whyAlert } from "./command-format.js";
import {
  BUDGET_MENU, CONFIG_TOGGLES, configToggleOn, GOAL_MENU, MEMORY_MENU_EXTRAS, TASK_MENU_EXTRAS, toggleMenu, type ConfigToggle
} from "./commands.js";
import { cliJson, cliText, errorMessage } from "./crewcoder-cli.js";
import { HUNK_COMMAND, HUNK_INSTALL_HINT, hunkDiffArgs, type TerminalRun } from "./hunk.js";
import type { PaletteCommand } from "./palette-model.js";
import type { PickerFlows, PickerHost } from "./picker-flows.js";
import { MIN_SIDEBAR_TERMINAL_WIDTH } from "./sidebar-model.js";
import type { SidebarController } from "./sidebar.js";

/** A summary waiting in the compaction editor, idle (saved session) or live (running loop). */
export type SummaryEditorState = {
  summary: string;
  context: { mode: "idle"; sessionId: string } | { mode: "live"; previewId: string };
  source?: string;
  originalMessageCount?: number;
  retainedMessageCount?: number;
};

/** What commands may do to the session. Implemented by SessionController. */
export interface CommandHost extends PickerHost {
  openCommandPalette(): void;
  openMenu(title: string, items: PaletteCommand[], load?: () => Promise<PaletteCommand[]>): void;
  startPrompt(text: string): void;
  /** `/crew`, `/team`: ask here-or-tmux when tmux is available, then run; `command` is the typed text. */
  launchCrew(target: CrewCoderCrewTarget, task: string, command: string): void;
  queueFollowUp(text: string): boolean;
  resolveApproval(approvalId: string | undefined, approved: boolean): void;
  clearScreen(): void;
  openSummaryEditor(editor: SummaryEditorState): void;
  requestLiveCompactionPreview(): boolean;
  /** Hands the terminal to a full-screen program (wired by cli.tsx); undefined without one. */
  readonly runInTerminal: TerminalRun | undefined;
  /** Redraws every cell of the screen (wired by cli.tsx); undefined without a renderer. */
  readonly repaint: (() => void) | undefined;
  /** Leaves the UI like Ctrl+C (wired by cli.tsx); undefined without a renderer. */
  readonly quit: (() => void) | undefined;
  readonly sidebar: SidebarController;
  /** `/find [text]`: open transcript search, like Ctrl+F. */
  openSearch(query?: string): void;
}

type Handler = (rest: string) => void | Promise<void>;

const TASKS_ENV = "CREWCODER_TASKS_ENABLED";
/** Extension commands are typed as `/ext.<extension-id>.<command-id> [args]`. */
const EXTENSION_COMMAND_PREFIX = "/ext.";

/**
 * Every slash command that is not a picker. Results are alerts (status,
 * on/off, and text output); failures are error alerts. None of them sends a
 * prompt to the agent except /approve-plan, which is a prompt by design.
 */
export class CommandRunner {
  private readonly host: CommandHost;
  private readonly flows: PickerFlows;
  private readonly handlers: Readonly<Record<string, Handler>>;

  constructor(host: CommandHost, flows: PickerFlows) {
    this.host = host;
    this.flows = flows;
    const followUp: Handler = (rest) => this.followUp(rest);
    this.handlers = {
      "/help": () => this.host.openCommandPalette(),
      "/thinking": (rest) => this.configToggle("/thinking", rest),
      "/identity": (rest) => this.configToggle("/identity", rest),
      "/checkpoints": (rest) => this.configToggle("/checkpoints", rest),
      "/compact": (rest) => this.compact(rest),
      "/full-access": (rest) => this.fullAccess(rest),
      "/memory": (rest) => this.memory(rest),
      "/remember": (rest) => this.remember(rest),
      "/set-budget": (rest) => this.setBudget(rest),
      "/add-dir": (rest) => this.addDirectory(rest),
      "/task": (rest) => this.task(rest),
      "/extensions": () => this.cliAlert("Extensions", ["extension", "list"]),
      "/plugins": () => this.plugins(),
      "/teams": () => this.cliAlert("Teams", ["crew", "team", "list"]),
      "/team": (rest) => this.team(rest),
      "/crew": (rest) => this.crew(rest),
      "/review-summary": () => this.reviewSummary(),
      "/why": () => this.why(),
      "/branch": (rest) => rest ? this.flows.branchById(rest) : this.branch(),
      "/export": (rest) => this.exportSession(rest),
      "/reload": () => this.reload(),
      "/goal": (rest) => this.goal(rest),
      "/clear": () => this.clear(),
      "/repaint": () => this.repaint(),
      "/redraw": () => this.repaint(),
      "/quit": () => this.quit(),
      "/find": (rest) => this.host.openSearch(rest.trim()),
      "/diff": () => this.diff(),
      "/sidebar": (rest) => this.setSidebar(rest),
      "/file-changes": (rest) => this.fileChanges(rest),
      "/approve": (rest) => this.host.resolveApproval(rest || undefined, true),
      "/deny": (rest) => this.host.resolveApproval(rest || undefined, false),
      "/approve-plan": () => this.approvePlan(),
      "/follow-up": followUp,
      "/followup": followUp
    };
  }

  /** Run `name` with the raw text after it. Returns false for commands it does not own. */
  run(name: string, rest: string): boolean {
    const handler = Object.hasOwn(this.handlers, name)
      ? this.handlers[name]
      : name.startsWith(EXTENSION_COMMAND_PREFIX) ? (text: string) => this.extensionCommand(name, text) : undefined;
    if (!handler) return false;
    Promise.resolve()
      .then(() => handler(rest.trim()))
      .catch((error: unknown) => this.alert({ variant: "error", title: name, body: errorMessage(error) }))
      .finally(() => this.host.changed());
    return true;
  }

  /** Install an edited summary into a saved session (idle compaction preview). */
  async applyEditedSummary(sessionId: string, summary: string): Promise<void> {
    if (isCrewCoderRemote()) {
      this.alert({ variant: "warning", title: "Not available in remote SSH mode", body: "Applying an edited summary needs a local file. Live previews and plain /compact work remotely." });
      return;
    }
    const file = path.join(os.tmpdir(), `crewcoder-compact-${sessionId}-${Date.now()}.md`);
    this.alert({ variant: "info", title: `Applying edited summary to ${sessionId}…` });
    try {
      await fs.writeFile(file, summary, "utf8");
      await cliText(this.host.cli, ["session", "compact", sessionId, "--summary-file", file, "--json"]);
      this.alert({ variant: "success", title: `Session ${sessionId} compacted with your summary` });
    } finally {
      await fs.unlink(file).catch(() => undefined);
    }
  }

  private alert(alert: FooterAlert): void {
    this.host.alert(alert);
  }

  private get state(): TuiState {
    return this.host.state;
  }

  private busy(action: string): boolean {
    if (!this.host.bridgeRunning && !this.state.running) return false;
    this.alert({ variant: "warning", title: `Wait for the current run to finish before ${action}`, body: "Use /stop to end it." });
    return true;
  }

  private savedSession(action: string): string | undefined {
    if (this.state.sessionId && this.state.sessionId !== "new") return this.state.sessionId;
    this.alert({ variant: "warning", title: `No saved session to ${action} yet`, body: "Send a prompt first." });
    return undefined;
  }

  /**
   * `/ext.<extension-id>.<command-id> [args]`: runs an extension's executable
   * command through `crewcoder command run`, which enforces the extension's
   * trust (as in the legacy UI). Its notifications come back as one alert;
   * nothing is sent to the agent. `--` keeps typed arguments from being read as
   * agent CLI options, and the CLI runs without a shell.
   */
  private async extensionCommand(name: string, rest: string): Promise<void> {
    const id = name.slice(1);
    if (id.length <= EXTENSION_COMMAND_PREFIX.length - 1) {
      this.usage("/ext.<extension-id>.<command-id> [args]. Run /commands to see extension commands.");
      return;
    }
    await this.cliAlert(name, ["command", "run", id, "--", ...rest.split(/\s+/).filter(Boolean)]);
  }

  private quit(): void {
    const quit = this.host.quit;
    if (!quit) {
      this.alert({ variant: "warning", title: "/quit needs an interactive terminal", body: "Press Ctrl+C to exit." });
      return;
    }
    quit();
  }

  /**
   * Recovery for a garbled screen: something wrote to the terminal behind
   * OpenTUI's back (a stray child process, a system message, a glitch after
   * /diff). Silent on success; the redrawn screen is the result.
   */
  private repaint(): void {
    const repaint = this.host.repaint;
    if (!repaint) {
      this.alert({ variant: "warning", title: "/repaint needs an interactive terminal" });
      return;
    }
    repaint();
  }

  /** Review this session's file changes in Hunk; the UI is suspended until Hunk exits. */
  private async diff(): Promise<void> {
    if (isCrewCoderRemote()) {
      this.alert({ variant: "warning", title: "/diff is not available in remote SSH mode", body: "Hunk runs on this machine; the changes live on the remote host." });
      return;
    }
    const run = this.host.runInTerminal;
    if (!run) {
      this.alert({ variant: "warning", title: "/diff needs an interactive terminal" });
      return;
    }
    const result = await run(HUNK_COMMAND, hunkDiffArgs(this.state.changedFiles, this.state.cwd), this.state.cwd);
    if (result.missing) {
      this.alert({ variant: "error", title: "Hunk is not installed", body: HUNK_INSTALL_HINT });
    } else if (result.code !== 0) {
      this.alert({ variant: "error", title: `hunk diff exited with ${result.code ?? "a signal"}`, body: result.stderr.trim() || undefined });
    }
  }

  /** Bare `/sidebar` toggles; on/off/status are explicit. Display only: nothing is saved. */
  private setSidebar(value: string): void {
    const action = value.toLowerCase();
    const sidebar = this.host.sidebar;
    if (action === "status") return this.alert({ variant: "info", title: `Sidebar is ${sidebar.open ? "open" : "closed"}` });
    if (action && action !== "on" && action !== "off") return this.usage("/sidebar on|off|status (bare /sidebar toggles)");
    const open = action ? action === "on" : !sidebar.open;
    if (open === sidebar.open) return this.alert({ variant: "info", title: `Sidebar already ${open ? "open" : "closed"}` });
    sidebar.setOpen(open);
    if (sidebar.hiddenByWidth) {
      this.alert({ variant: "warning", title: "Sidebar opened, but the terminal is too narrow", body: `It shows at ${MIN_SIDEBAR_TERMINAL_WIDTH} columns or wider.` });
    }
  }

  /**
   * Show or hide modified files in the sidebar. Tracking never stops, so
   * turning it back on restores the list. Instance-local and kept across /new.
   */
  private fileChanges(value: string): void {
    const action = value.toLowerCase();
    const count = this.state.changedFiles.length;
    if (action === "status") {
      return this.alert({ variant: "info", title: `File changes display is ${this.state.showFileChanges ? "on" : "off"}`, body: `File tracking remains active (${count} changed).` });
    }
    if (action && action !== "on" && action !== "off") return this.usage("/file-changes on|off|status (bare /file-changes toggles)");
    this.state.showFileChanges = action ? action === "on" : !this.state.showFileChanges;
    const hint = this.host.sidebar.open ? undefined : "The sidebar is closed; open it with /sidebar or Ctrl+B.";
    this.alert({
      variant: "success",
      title: `File changes display turned ${this.state.showFileChanges ? "on" : "off"}`,
      body: [`File tracking remains active (${count} changed).`, hint].filter(Boolean).join(" ")
    });
  }

  private usage(text: string): void {
    this.alert({ variant: "warning", title: "Usage", body: text });
  }

  private async readConfig(): Promise<Record<string, unknown>> {
    return cliJson<Record<string, unknown>>(this.host.cli, ["config", "show"], {});
  }

  private async cliAlert(title: string, args: string[], variant?: FooterAlert["variant"]): Promise<void> {
    const alert = cliOutputAlert(title, await this.host.cli.exec(args));
    this.alert(variant && alert.variant !== "error" ? { ...alert, variant } : alert);
  }

  private configToggle(name: ConfigToggle, value: string): Promise<void> | void {
    const toggle = CONFIG_TOGGLES[name];
    const action = value.toLowerCase();
    if (!action) {
      return this.host.openMenu(toggle.label, toggleMenu(name), async () => toggleMenu(name, configToggleOn(name, await this.readConfig())));
    }
    if (action === "status") {
      return this.readConfig().then((config) => {
        const on = configToggleOn(name, config);
        const note = name === "/checkpoints" ? "Existing checkpoints are preserved." : undefined;
        this.alert({ variant: "info", title: `${toggle.label}: ${on ? "on" : "off"}`, body: note });
      });
    }
    if (action !== "on" && action !== "off") return this.usage(`${name} on|off|status`);
    if (name === "/checkpoints" && this.busy("changing checkpoints")) return;
    return cliText(this.host.cli, ["config", "set", toggle.key, action === "on" ? "true" : "false"]).then(() => {
      if (name === "/thinking") this.state.thinkingEnabled = action === "on";
      if (name === "/identity") this.state.workerIdentityEnabled = action === "on";
      const note = name === "/checkpoints"
        ? `Existing checkpoints are preserved${action === "off" ? "; future runs will not create new ones" : ""}.`
        : name === "/identity" ? "Applies to future runs." : undefined;
      this.alert({ variant: "success", title: `${toggle.label} turned ${action}`, body: note });
    });
  }

  private fullAccess(value: string): void {
    const action = value.toLowerCase();
    if (!action) return this.host.openMenu("Full access", toggleMenu("/full-access", this.state.fullAccess));
    if (action === "status") {
      return this.alert({ variant: this.state.fullAccess ? "warning" : "info", title: `Full access is ${this.state.fullAccess ? "on" : "off"} for this session` });
    }
    if (action !== "on" && action !== "off") return this.usage("/full-access on|off|status");
    this.state.fullAccess = action === "on";
    this.alert(this.state.fullAccess
      ? { variant: "warning", title: "Full access enabled", body: "Future tool calls in this session bypass approval prompts, including dangerous commands." }
      : { variant: "success", title: "Full access disabled", body: "Future mutating and dangerous tool calls require approval." });
  }

  private compact(value: string): Promise<void> | void {
    const action = value.toLowerCase();
    if (!action) return this.compactNow();
    if (action === "preview" || action === "edit") return this.previewCompaction();
    if (action === "auto") return this.configToggle("/compact auto", "");
    if (action === "on" || action === "off" || action === "status") return this.configToggle("/compact auto", action);
    if (action.startsWith("auto ")) return this.configToggle("/compact auto", action.slice(5));
    return this.usage("/compact (now) · /compact preview · /compact on|off|status");
  }

  private async compactNow(): Promise<void> {
    if (this.busy("compacting")) return;
    const sessionId = this.savedSession("compact");
    if (!sessionId) return;
    this.alert({ variant: "info", title: `Compacting session ${sessionId}…` });
    const result = parseCompactionResult(await cliText(this.host.cli, ["session", "compact", sessionId, ...this.modelArgs(), "--json"]));
    if (!result.compacted) return this.alert({ variant: "info", title: "Nothing to compact yet", body: "This session is still too small." });
    const counts = result.originalMessageCount !== undefined && result.retainedMessageCount !== undefined
      ? `${result.originalMessageCount} → ${result.retainedMessageCount} messages` : undefined;
    this.alert({ variant: "success", title: `Session ${sessionId} compacted`, body: counts });
  }

  private async previewCompaction(): Promise<void> {
    // Live run: the loop answers with a session_compaction_preview event, which opens the editor.
    if (this.host.bridgeRunning) {
      if (this.host.requestLiveCompactionPreview()) this.alert({ variant: "info", title: "Requested a compaction preview", body: "The editor opens when the summary is ready." });
      else this.alert({ variant: "error", title: "No active run to preview compaction for" });
      return;
    }
    if (this.state.running) return void this.busy("previewing compaction");
    const sessionId = this.savedSession("preview");
    if (!sessionId) return;
    this.alert({ variant: "info", title: "Preparing the compaction summary…" });
    const preview = await cliJson<Record<string, unknown>>(this.host.cli, ["session", "compact", sessionId, "--preview", ...this.modelArgs(), "--json"], {});
    if (preview.preview !== true || typeof preview.summary !== "string") {
      return this.alert({ variant: "info", title: "Nothing to preview yet", body: "This session is still too small to compact." });
    }
    this.host.openSummaryEditor({
      summary: preview.summary,
      context: { mode: "idle", sessionId },
      source: typeof preview.source === "string" ? preview.source : undefined,
      originalMessageCount: typeof preview.originalMessageCount === "number" ? preview.originalMessageCount : undefined,
      retainedMessageCount: typeof preview.retainedMessageCount === "number" ? preview.retainedMessageCount : undefined
    });
  }

  private modelArgs(): string[] {
    const args = ["--provider", this.state.provider];
    if (this.state.model) args.push("--model", this.state.model);
    if (this.state.effort) args.push("--effort", this.state.effort);
    return args;
  }

  private memory(value: string): Promise<void> | void {
    const action = value.toLowerCase();
    if (!action) return this.host.openMenu("Project memory", toggleMenu("/memory", undefined, [...MEMORY_MENU_EXTRAS]));
    if (action !== "on" && action !== "off" && action !== "status" && action !== "list") return this.usage("/memory on|off|status|list");
    return this.cliAlert(action === "list" ? "Remembered facts" : "Project memory", ["memory", action], action === "on" || action === "off" ? "success" : undefined);
  }

  private remember(fact: string): Promise<void> | void {
    if (!fact) return this.host.setComposerDraft("/remember ");
    return this.cliAlert("Remembered", ["remember", fact], "success");
  }

  private setBudget(value: string): void {
    const normalized = value.toLowerCase();
    if (!normalized) return this.host.openMenu("Token budget", [...BUDGET_MENU]);
    if (normalized === "status") {
      return this.alert(this.state.tokenBudget
        ? { variant: "info", title: `Token budget: ${formatBudgetTokens(this.state.tokenBudget)} tokens`, body: "Clear it with /set-budget off." }
        : { variant: "info", title: "No token budget set", body: "This session is unbounded. Set one with /set-budget 200k." });
    }
    if (normalized === "off" || normalized === "none" || normalized === "0") {
      this.state.tokenBudget = undefined;
      this.state.usage = { ...this.state.usage, tokenBudget: undefined, budgetExceeded: undefined };
      return this.alert({ variant: "success", title: "Token budget cleared", body: "This session is unbounded again." });
    }
    const parsed = parseBudgetInput(normalized);
    if (parsed === undefined) return this.usage("/set-budget 200k|1.5m|250000|off|status");
    this.state.tokenBudget = parsed;
    this.state.usage = { ...this.state.usage, tokenBudget: parsed };
    this.alert({ variant: "success", title: `Token budget set to ${formatBudgetTokens(parsed)} tokens`, body: "Applies from your next message. A warning shows at 80%; the run stops at the limit." });
  }

  private async addDirectory(directory: string): Promise<void> {
    if (!directory) {
      const dirs = this.state.externalDirectories;
      return this.alert({ variant: "info", title: dirs.length ? "External directories" : "No external directories attached", body: dirs.length ? `${dirs.join("\n")}\n\nAdd another with /add-dir <path>.` : "Add one with /add-dir <path>." });
    }
    if (this.busy("changing external directories")) return;
    const sessionId = this.state.sessionId && this.state.sessionId !== "new" ? this.state.sessionId : undefined;
    const parsed = await cliJson<unknown>(this.host.cli, sessionId
      ? ["session", "add-dir", sessionId, directory, "--json"]
      : ["session", "validate-dir", directory, "--json"], null);
    const added = Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : parsed && typeof parsed === "object" && typeof (parsed as Record<string, unknown>).path === "string"
        ? [...this.state.externalDirectories, (parsed as Record<string, unknown>).path as string]
        : [];
    this.state.externalDirectories = [...new Set(added)];
    this.alert({ variant: "success", title: "External directory attached to this session", body: this.state.externalDirectories.at(-1) ?? directory });
  }

  private task(value: string): Promise<void> | void {
    const parts = value.split(/\s+/).filter(Boolean);
    const action = parts[0]?.toLowerCase();
    const override = process.env[TASKS_ENV];
    if (!action) {
      return this.host.openMenu("Tasks (this instance)", toggleMenu("/task", override === undefined ? undefined : override === "true", [...TASK_MENU_EXTRAS]));
    }
    if (action === "status") {
      return this.alert({
        variant: "info",
        title: override === undefined ? "Tasks use the shared default" : `Tasks are ${override === "true" ? "on" : "off"} for this instance`,
        body: override === undefined ? "Use /task on or /task off to override it for this instance only." : undefined
      });
    }
    if (action === "on" || action === "off") {
      // Instance-local: inherited by this process's agent children only; the shared config is untouched.
      process.env[TASKS_ENV] = action === "on" ? "true" : "false";
      return this.alert({ variant: "success", title: `Tasks turned ${action} for this instance`, body: "Other running instances and the shared default were not changed." });
    }
    return this.cliAlert("Tasks", ["task", ...parts]);
  }

  /** CrewCode app plugin templates: only meaningful with CrewCode integration on. */
  private plugins(): Promise<void> | void {
    if (this.state.integrationProfile !== "crewcode") {
      return this.alert({ variant: "warning", title: "CrewCode integration is disabled for this project", body: "Enable it with /profile crewcode." });
    }
    return this.cliAlert("CrewCode plugin templates", ["plugin", "list-templates"]);
  }

  /** `/team <team> <task>`: a team declared in crewcoder.json, streamed live. */
  private team(value: string): void {
    const usage = "/team <team> <task> (use /teams to list teams)";
    const match = /^(\S+)\s+([\s\S]+)$/.exec(value);
    if (!match) return this.usage(usage);
    const [, team = "", task = ""] = match;
    if (!isCrewName(team)) return this.usage(`${usage}\nTeam ids are letters, digits, and . _ - (not ${team}).`);
    this.host.launchCrew({ kind: "team", team }, task.trim(), `/team ${team} ${task.trim()}`);
  }

  /** `/crew <worker1,worker2> <task>`: named workers in order, streamed live. */
  private crew(value: string): void {
    const usage = "/crew <worker1,worker2> <task> (use /workers to list workers)";
    const match = /^(\S+)\s+([\s\S]+)$/.exec(value);
    if (!match) return this.usage(usage);
    const [, list = "", task = ""] = match;
    const workers = [...new Set(list.split(",").map((name) => name.trim()).filter(Boolean))];
    const bad = workers.find((name) => !isCrewName(name));
    if (!workers.length || bad !== undefined) return this.usage(`${usage}\nWorker names are letters, digits, and . _ - (not ${bad ?? list}).`);
    this.host.launchCrew({ kind: "workers", workers }, task.trim(), `/crew ${workers.join(",")} ${task.trim()}`);
  }

  private async reviewSummary(): Promise<void> {
    this.alert(reviewSummaryAlert(parseReviewSummary(await cliText(this.host.cli, ["git", "review-summary", "--json"]))));
  }

  /** A one-shot `session why`, never a prompt in the session. */
  private async why(): Promise<void> {
    const sessionId = this.savedSession("explain");
    if (!sessionId) return;
    this.alert({ variant: "info", title: "Asking the model to explain its last decision…" });
    const decision = parseDecisionExplanation(await cliText(this.host.cli, ["session", "why", sessionId, "--json", ...this.modelArgs()]));
    this.alert(decision ? whyAlert(decision) : { variant: "info", title: "Nothing to explain yet", body: "This session has no agent turn." });
  }

  /**
   * Fork the current session in place. Refused mid-run: the copy would miss the
   * rest of the turn (and any follow-ups), which keep going to the original.
   */
  private async branch(): Promise<void> {
    if (this.busy("branching the session")) return;
    const source = this.savedSession("branch");
    if (!source) return;
    const branched = await this.host.cli.branch(source);
    this.state.sessionId = branched || source;
    this.alert({ variant: "success", title: "Branched session", body: `${source} → ${this.state.sessionId}. New messages go to the branch.` });
  }

  private async exportSession(outPath: string): Promise<void> {
    const sessionId = this.savedSession("export");
    if (!sessionId) return;
    const target = outPath || `${sessionId}.html`;
    const stdout = await cliText(this.host.cli, ["session", "export", sessionId, "--html", "--out", target]);
    this.alert({ variant: "success", title: "Session exported", body: stdout.trim() || target });
  }

  private async reload(): Promise<void> {
    if (this.busy("reloading")) return;
    const [config, providers, profile] = await Promise.all([
      this.readConfig(),
      this.flows.reloadProviders(),
      cliText(this.host.cli, ["profile", "show"]).then((text) => text.trim(), () => undefined)
    ]);
    const state = this.state;
    if (profile === "crewcode" || profile === "standalone") state.integrationProfile = profile;
    if (typeof config.defaultMode === "string") {
      state.mode = normalizeTuiMode(config.defaultMode);
      if (state.mode === "plugin" && state.integrationProfile !== "crewcode") state.mode = "general";
    }
    if (typeof config.defaultProvider === "string" && config.defaultProvider.trim()) state.provider = config.defaultProvider.trim();
    if (typeof config.defaultModel === "string" && config.defaultModel.trim()) state.model = config.defaultModel.trim();
    state.thinkingEnabled = config.thinkingEnabled !== false;
    state.workerIdentityEnabled = config.workerIdentityEnabled === true;
    const provider = providers.find((item) => item.id === state.provider) ?? providers[0];
    if (provider) {
      state.provider = provider.id;
      if (provider.models.length && !provider.models.includes(state.model)) state.model = provider.defaultModel ?? provider.models[0] ?? state.model;
    }
    const levels = effortLevelsForModel(state.provider, state.model);
    if (!levels.includes(state.effort)) state.effort = levels[0] ?? state.effort;
    this.alert({ variant: "success", title: "Reloaded CrewCoder", body: `${providers.length} provider${providers.length === 1 ? "" : "s"} · profile ${state.integrationProfile} · ${state.provider}/${state.model}` });
  }

  private async goal(input: string): Promise<void> {
    if (!input) return this.host.openMenu("Goal", [...GOAL_MENU]);
    const parts = tokenizeGoalCommand(input);
    const action = parts[0]?.toLowerCase();
    const approval = this.state.fullAccess ? "full-access" : "review";
    if (action === "status") return this.goalArgs(["goal", "status", ...parts.slice(1), "--json"]);
    if (action === "list") return this.goalArgs(["goal", "list", "--json"]);
    if (action === "logs") {
      const stdout = await cliText(this.host.cli, ["goal", "logs", ...parts.slice(1, 2)]);
      const lines = stdout.split("\n").filter(Boolean).slice(-30);
      return this.alert({ variant: "info", title: "Recent goal events", body: lines.length ? lines.join("\n") : "No goal events recorded yet." });
    }
    if (action === "pause" || action === "clear" || action === "approve" || action === "deny") {
      return this.goalArgs(["goal", action, ...parts.slice(1), "--json"]);
    }
    if (action === "resume") return this.goalArgs(["goal", "resume", ...parts.slice(1), "--approval", approval, "--json"]);
    return this.startGoal(parseGoalStartInput(action === "start" ? parts.slice(1) : parts));
  }

  /** Detached goals run in CrewCoder's supervisor; closing the TUI does not stop them. */
  private startGoal(start: GoalStartInput): Promise<void> {
    const state = this.state;
    const args = ["goal", "start", start.objective, "--provider", state.provider, "--model", state.model, "--mode", state.mode,
      "--effort", state.effort, "--approval", state.fullAccess ? "full-access" : "review", "--json"];
    if (start.maxTurns !== undefined) args.push("--max-turns", String(start.maxTurns));
    if (start.timeoutMinutes !== undefined) args.push("--timeout-minutes", String(start.timeoutMinutes));
    if (start.checkModel) args.push("--check-model", start.checkModel);
    else if (start.disableCheckModel) args.push("--no-check-model");
    if (state.tokenBudget) args.push("--budget", String(state.tokenBudget));
    if (state.systemPrompt) args.push("--system-prompt", state.systemPrompt);
    if (state.worker) args.push("--worker", state.worker);
    return this.goalArgs(args);
  }

  private async goalArgs(args: string[]): Promise<void> {
    const parsed = await cliJson<unknown>(this.host.cli, args, null);
    const records = Array.isArray(parsed) ? parsed : [parsed];
    const goals = records.flatMap((record) => {
      const goal = parseGoalRecord(JSON.stringify(record));
      return goal ? [goal] : [];
    });
    this.alert(goalsAlert(goals.slice(0, 10)));
  }

  private clear(): void {
    if (this.busy("clearing the screen")) return;
    this.host.clearScreen();
  }

  private approvePlan(): void {
    // A CrewCoder-mode plan acceptance is a prompt, not a tool-call approval.
    if (this.host.bridgeRunning) {
      if (!this.host.queueFollowUp("/approve-plan")) this.alert({ variant: "error", title: "Could not send /approve-plan to the active run" });
      return;
    }
    this.host.startPrompt("/approve-plan");
  }

  private followUp(message: string): void {
    if (!message) return this.usage("/follow-up <message>");
    if (!this.host.bridgeRunning) {
      return this.alert({ variant: "warning", title: "No active run", body: "Send a normal message to start or resume the session." });
    }
    if (!this.host.queueFollowUp(message)) this.alert({ variant: "error", title: "Could not queue the follow-up for the active run" });
  }
}
