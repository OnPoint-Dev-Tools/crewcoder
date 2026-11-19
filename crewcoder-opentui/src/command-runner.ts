import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isCrewCoderRemote } from "@onpoint-dev-tools/crewcoder-tui-core/bridge/crewcoder-process";
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
  queueFollowUp(text: string): boolean;
  resolveApproval(approvalId: string | undefined, approved: boolean): void;
  clearScreen(): void;
  openSummaryEditor(editor: SummaryEditorState): void;
  requestLiveCompactionPreview(): boolean;
  /** Hands the terminal to a full-screen program (wired by cli.tsx); undefined without one. */
  readonly runInTerminal: TerminalRun | undefined;
}

type Handler = (rest: string) => void | Promise<void>;

const TASKS_ENV = "CREWCODER_TASKS_ENABLED";

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
      "/review-summary": () => this.reviewSummary(),
      "/why": () => this.why(),
      "/branch": () => this.branch(),
      "/export": (rest) => this.exportSession(rest),
      "/reload": () => this.reload(),
      "/goal": (rest) => this.goal(rest),
      "/clear": () => this.clear(),
      "/diff": () => this.diff(),
      "/approve": (rest) => this.host.resolveApproval(rest || undefined, true),
      "/deny": (rest) => this.host.resolveApproval(rest || undefined, false),
      "/approve-plan": () => this.approvePlan(),
      "/follow-up": followUp,
      "/followup": followUp
    };
  }

  /** Run `name` with the raw text after it. Returns false for commands it does not own. */
  run(name: string, rest: string): boolean {
    const handler = Object.hasOwn(this.handlers, name) ? this.handlers[name] : undefined;
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

  private async team(value: string): Promise<void> {
    const match = /^(\S+)\s+([\s\S]+)$/.exec(value);
    if (!match) return this.usage("/team <team> <task> (use /teams to list teams)");
    const [, team = "", task = ""] = match;
    this.alert({ variant: "info", title: `Running team ${team}…`, body: task.trim() });
    await this.cliAlert(`Team ${team}`, ["crew", "team", "run", team, task.trim(), ...this.crewRunOptions()]);
  }

  private crewRunOptions(): string[] {
    const args = ["--provider", this.state.provider, "--mode", this.state.mode, "--effort", this.state.effort, "--approval", this.state.fullAccess ? "full-access" : "review"];
    if (this.state.model) args.push("--model", this.state.model);
    if (this.state.systemPrompt) args.push("--system-prompt", this.state.systemPrompt);
    return args;
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

  private async branch(): Promise<void> {
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
