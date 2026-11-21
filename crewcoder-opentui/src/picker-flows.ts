import path from "node:path";
import type { ProviderRecord, SessionRecord } from "@onpoint-dev-tools/crewcoder-tui-core/bridge/crewcoder-process";
import { DEFAULT_EFFORT, effortLevelsForModel, normalizeEffort } from "@onpoint-dev-tools/crewcoder-tui-core/state/effort-levels";
import { builtinProviderDefaults, resolveProviderRecord } from "@onpoint-dev-tools/crewcoder-tui-core/state/provider-defaults";
import { isTuiMode, type TuiEventBlock, type TuiState } from "@onpoint-dev-tools/crewcoder-tui-core/state/tui-store";
import type { FooterAlert } from "./alert-model.js";
import {
  cliJson, cliText, errorMessage, readToolMode,
  type CrewCoderCli, type LoadedPromptCommand, type LoadedSkill, type NamedEntry, type RewindPreview, type RewindResult, type WorkerSummary
} from "./crewcoder-cli.js";
import { actionLabel } from "./keybindings.js";
import type { PaletteCommand } from "./palette-model.js";
import type { ThemeController } from "./theme-controller.js";
import {
  checkpointItems, directoryItems, effortItems, modeItems, modelItems, namedItems, profileItems, providerItems,
  rewindConfirmItems, sessionItems, toolModeItems, workerItems, type Picker, type PickerKind
} from "./pickers.js";

/** What picker flows may do to the session. Implemented by SessionController. */
export interface PickerHost {
  readonly state: TuiState;
  readonly cli: CrewCoderCli;
  readonly bridgeRunning: boolean;
  openPicker(picker: Picker): void;
  /** The open picker, used to drop results for a picker the user already left. */
  readonly picker: Picker | undefined;
  push(block: TuiEventBlock): void;
  /** Show a status alert above the composer until the next key. */
  alert(alert: FooterAlert): void;
  changed(): void;
  resumeSession(session: SessionRecord): void;
  setComposerDraft(text: string): void;
  attachSkill(skill: LoadedSkill): void;
  /** The active theme, the `/theme` list, preview, and the saved pick. */
  readonly themes: ThemeController;
}

export type OpenableKind = Exclude<PickerKind, "commands" | "menu" | "rewindConfirm" | "crewLaunch">;

const SESSION_HINT = `↑↓ navigate · Enter resume · ${actionLabel("sessionBranch")} branch · Esc close`;
const THEME_HINT = "↑↓ preview · Enter apply · Esc keep current";

const picker = (kind: PickerKind, title: string, items: PaletteCommand[] = [], loading = false, emptyText = "Nothing to pick"): Picker =>
  ({ kind, title, placeholder: "Search…", emptyText, items, loading });

export class PickerFlows {
  private readonly host: PickerHost;
  private providers: ProviderRecord[] | undefined;
  private sessions: SessionRecord[] = [];
  private workers: WorkerSummary[] = [];

  constructor(host: PickerHost) {
    this.host = host;
  }

  open(kind: OpenableKind): void {
    const { state } = this.host;
    switch (kind) {
      case "provider":
        return this.load(picker("provider", "Provider", [], true), async () => providerItems(await this.loadProviders(), state.provider));
      case "model":
        return this.load(picker("model", "Model", [], true), async () => modelItems(state.provider, (await this.loadProviders()).find((item) => item.id === state.provider), state.model));
      case "effort":
        return this.host.openPicker(picker("effort", `Reasoning effort · ${state.model}`, effortItems(state.provider, state.model, state.effort)));
      case "mode":
        // Built-in modes show at once; saved workers fill in when listed.
        return this.load(picker("mode", "Mode or worker", modeItems(state, this.workers), true), async () =>
          modeItems(state, await this.loadWorkers().catch(() => this.workers)));
      case "systemPrompt":
        return this.load(picker("systemPrompt", "System prompt", [], true, "No system prompts in ~/.crewcoder/system-prompts/"), async () =>
          namedItems(await cliJson<NamedEntry[]>(this.host.cli, ["system-prompt", "list", "--json"], []), state.systemPrompt));
      case "promptCommand":
        return this.load(picker("promptCommand", "Insert prompt command", [], true, "No prompt commands in ~/.crewcoder/commands/"), async () =>
          namedItems(await cliJson<NamedEntry[]>(this.host.cli, ["command", "list", "--json"], [])));
      case "skill":
        return this.load(picker("skill", "Attach a skill", [], true, "No skills in ~/.crewcoder/skills/"), async () =>
          namedItems(await cliJson<NamedEntry[]>(this.host.cli, ["skill", "list", "--json"], [])));
      case "profile":
        return this.host.openPicker(picker("profile", "Integration profile", profileItems(state.integrationProfile)));
      case "toolMode":
        if (this.blockedWhileRunning("changing Tool mode")) return;
        return this.load(picker("toolMode", "Tool mode for new sessions", [], true), async () => toolModeItems(await readToolMode(this.host.cli)));
      case "removeDir":
        if (!state.externalDirectories.length) return this.host.alert({ variant: "info", title: "No external directories attached" });
        return this.host.openPicker(picker("removeDir", "Remove external directory", directoryItems(state.externalDirectories)));
      case "session":
        return this.load({ ...picker("session", "Resume session", [], true, "No sessions found"), hint: SESSION_HINT }, async () => {
          this.sessions = await this.host.cli.sessions();
          return sessionItems(this.sessions, state.sessionId);
        });
      case "rewind":
        if (!state.checkpoints.length) {
          return this.host.alert({ variant: "warning", title: "No checkpoint found", body: "Run a mutating tool first, then use /rewind." });
        }
        return this.host.openPicker(picker("rewind", "Rewind to checkpoint", checkpointItems(state.checkpoints)));
      case "handoff":
        if (!hasSavedSession(state)) return this.noSavedSession("handing it off");
        return this.load(picker("handoff", "Hand off to worker", [], true, "No workers. Create one with: crewcoder workers create <name>"), async () =>
          workerItems(await this.loadWorkers()));
      case "theme":
        // Local UI files (also in --remote mode: the theme belongs to this terminal, not the workspace).
        return this.host.openPicker({ ...picker("theme", "Theme", this.host.themes.items()), hint: THEME_HINT });
    }
  }

  /** Apply a choice. The picker is already closed; a follow-up picker may open. */
  async select(kind: PickerKind, id: string): Promise<void> {
    const { state } = this.host;
    switch (kind) {
      case "commands":
      case "menu":
      case "crewLaunch":
        return;
      case "provider":
        state.provider = id;
        return this.open("model");
      case "model": {
        state.model = id;
        const levels = effortLevelsForModel(state.provider, state.model);
        if (!levels.includes(state.effort)) state.effort = levels[0] ?? state.effort;
        return this.open("effort");
      }
      case "effort":
        state.effort = normalizeEffort(id, effortLevelsForModel(state.provider, state.model)) ?? state.effort;
        return;
      case "mode":
        return this.selectMode(id);
      case "systemPrompt":
        await cliText(this.host.cli, ["system-prompt", "show", id, "--json"]);
        state.systemPrompt = id;
        return this.host.alert({ variant: "success", title: `System prompt selected: ${id}` });
      case "promptCommand":
        return this.insertPromptCommand(id);
      case "skill": {
        const skill = await cliJson<LoadedSkill | null>(this.host.cli, ["skill", "show", id, "--json"], null);
        if (!skill) throw new Error(`Skill not found: ${id}`);
        return this.host.attachSkill(skill);
      }
      case "profile":
        return this.setProfile(id === "crewcode" ? "crewcode" : "standalone");
      case "toolMode":
        await cliText(this.host.cli, ["config", "set", "toolMode", id]);
        return this.host.alert({ variant: "success", title: `Tool mode set to ${id} for new sessions`, body: "Use /new to apply it; existing sessions keep their mode." });
      case "removeDir":
        return this.removeDirectory(id);
      case "session": {
        const session = this.sessions.find((item) => item.id === id);
        if (session) this.host.resumeSession(session);
        return;
      }
      case "rewind":
        return this.previewRewind(id);
      case "rewindConfirm":
        if (id.startsWith("restore:")) return this.restore(id.slice("restore:".length));
        return this.host.alert({ variant: "info", title: "Rewind cancelled" });
      case "handoff":
        return this.handoff(id);
      case "theme":
        return this.applyTheme(id);
    }
  }

  /**
   * A picker command with an argument (`/effort high`, `/provider opencode`,
   * `/rewind latest`, ...): apply it directly, through the same path as picking it.
   */
  async applyArgument(kind: OpenableKind, arg: string): Promise<void> {
    const { state } = this.host;
    switch (kind) {
      case "provider":
        return this.setProvider(arg);
      case "model": {
        state.model = arg;
        const levels = effortLevelsForModel(state.provider, state.model);
        if (!levels.includes(state.effort)) state.effort = levels[0] ?? state.effort;
        return this.host.alert({ variant: "success", title: `Model: ${state.model}`, body: `Reasoning effort: ${state.effort}` });
      }
      case "effort": {
        const levels = effortLevelsForModel(state.provider, state.model);
        const effort = normalizeEffort(arg, levels);
        if (!effort) return this.host.alert({ variant: "error", title: `Unknown effort: ${arg}`, body: `${state.model} supports: ${levels.join(", ")}` });
        state.effort = effort;
        return this.host.alert({ variant: "success", title: `Reasoning effort: ${effort}` });
      }
      case "mode":
        return this.selectModeOrWorker(arg);
      case "promptCommand": {
        const [name = "", ...args] = arg.split(/\s+/);
        return this.insertPromptCommand(name, args);
      }
      case "profile":
        if (arg !== "standalone" && arg !== "crewcode") return this.usage("/profile standalone|crewcode");
        return this.setProfile(arg);
      case "toolMode":
        if (arg === "status") {
          const mode = await readToolMode(this.host.cli);
          return this.host.alert({ variant: "info", title: `Tool mode for new sessions: ${mode}`, body: "Existing sessions keep their saved mode; host policy takes precedence." });
        }
        if (arg !== "native" && arg !== "crewcoder") return this.usage("/tool-mode native|crewcoder|status");
        if (this.blockedWhileRunning("changing Tool mode")) return;
        return this.select("toolMode", arg);
      case "session":
        return this.resumeById(arg);
      case "rewind": {
        const id = arg === "latest" ? state.checkpoints.at(-1)?.id : arg;
        if (!id) return this.host.alert({ variant: "warning", title: "No checkpoint found", body: "Run a mutating tool with /checkpoints on, then use /rewind." });
        return this.previewRewind(id);
      }
      case "handoff": {
        const match = /^(?:worker:)?(\S+)(?:\s+([\s\S]+))?$/.exec(arg);
        if (!match?.[1]) return this.usage("/handoff worker:<name> [continuation prompt]");
        return this.handoff(match[1], match[2]?.trim());
      }
      case "systemPrompt":
      case "skill":
      case "removeDir":
      case "theme":
        return this.select(kind, arg);
    }
  }

  /** Picker Enter and `/theme <name>`: apply, save, and say where it is saved. */
  private applyTheme(id: string): void {
    this.host.alert({ variant: "success", ...this.host.themes.apply(id) });
  }

  /** Effort to resume a session with: its saved level when the model supports it. */
  static resumeEffort(state: TuiState, saved: string | undefined): TuiState["effort"] {
    const levels = effortLevelsForModel(state.provider, state.model);
    return normalizeEffort(saved, levels) ?? normalizeEffort(state.effort, levels) ?? DEFAULT_EFFORT;
  }

  /** Drop cached providers and workers, then list providers again (`/reload`). */
  async reloadProviders(): Promise<ProviderRecord[]> {
    this.providers = undefined;
    this.workers = [];
    return this.loadProviders();
  }

  /** Open `initial` (loading) and fill it in; ignored if the user already left it. */
  load(initial: Picker, items: () => Promise<PaletteCommand[]>): void {
    this.host.openPicker(initial);
    items().then(
      (loaded) => {
        if (this.host.picker !== initial) return;
        this.host.openPicker({ ...initial, items: loaded, loading: false });
      },
      (error: unknown) => {
        if (this.host.picker !== initial) return;
        this.host.openPicker({ ...initial, loading: false, emptyText: `Error: ${errorMessage(error)}` });
      }
    );
  }

  private async loadProviders(): Promise<ProviderRecord[]> {
    if (this.providers) return this.providers;
    try {
      const providers = await this.host.cli.providers();
      if (providers.length) this.providers = providers;
    } catch {
      // Offline or older CLI: fall back to the built-in catalog below.
    }
    return this.providers ?? builtinProviderDefaults;
  }

  private async loadWorkers(): Promise<WorkerSummary[]> {
    this.workers = await cliJson<WorkerSummary[]>(this.host.cli, ["workers", "list", "--json"], []);
    return this.workers;
  }

  private selectMode(id: string): void {
    const { state } = this.host;
    if (id.startsWith("worker:")) {
      // Per-session only: sent as --worker on each run; the global active worker is unchanged.
      state.worker = id.slice("worker:".length);
      return;
    }
    if (!isTuiMode(id)) return;
    if (id === "plugin" && state.integrationProfile !== "crewcode") {
      this.host.alert({ variant: "warning", title: "CrewCode integration is disabled for this project", body: "Enable it with /profile." });
      return;
    }
    state.mode = id;
    state.worker = undefined;
  }

  /** Typed provider: must be one CrewCoder knows; keeps a model the provider offers. */
  private async setProvider(id: string): Promise<void> {
    const { state } = this.host;
    const providers = await this.loadProviders();
    const provider = providers.find((item) => item.id === id);
    if (!provider) {
      return this.host.alert({ variant: "error", title: `Unknown provider: ${id}`, body: `Available: ${providers.map((item) => item.id).join(", ")}` });
    }
    state.provider = provider.id;
    const models = resolveProviderRecord(provider.id, provider);
    if (models.models.length && !models.models.includes(state.model)) state.model = models.defaultModel ?? models.models[0] ?? state.model;
    const levels = effortLevelsForModel(state.provider, state.model);
    if (!levels.includes(state.effort)) state.effort = levels[0] ?? state.effort;
    this.host.alert({ variant: "success", title: `Provider: ${state.provider}`, body: `Model: ${state.model} · effort ${state.effort}` });
  }

  /** Typed mode or saved worker name. */
  private async selectModeOrWorker(name: string): Promise<void> {
    const { state } = this.host;
    if (isTuiMode(name)) {
      this.selectMode(name);
      if (state.mode === name) this.host.alert({ variant: "success", title: `Mode: ${name}` });
      return;
    }
    const workers = await this.loadWorkers();
    if (!workers.some((worker) => worker.name === name)) {
      return this.host.alert({ variant: "error", title: `No mode or worker named ${name}`, body: `Modes: general, crewcoder, extension${this.host.state.integrationProfile === "crewcode" ? ", plugin" : ""}. Workers: ${workers.map((worker) => worker.name).join(", ") || "none"}` });
    }
    this.selectMode(`worker:${name}`);
    this.host.alert({ variant: "success", title: `Worker: ${name}`, body: "This session only." });
  }

  /**
   * Fork a listed session and open the fork (Tab in /sessions, `/branch <id>`).
   * The branch loads like a resume, with its conversation and saved settings, so
   * the screen and new messages both belong to it; the original is untouched.
   */
  async branch(id: string): Promise<void> {
    if (this.blockedWhileRunning("branching a session")) return;
    const source = this.sessions.find((session) => session.id === id);
    if (!source) return this.host.alert({ variant: "error", title: `Session not found: ${id}`, body: "Run /sessions to pick from the list." });
    this.host.alert({ variant: "info", title: "Branching session…" });
    const branchedId = (await this.host.cli.branch(source.id)).trim();
    if (!branchedId || branchedId === source.id) throw new Error("session branch did not return a new session id.");
    this.host.resumeSession({ ...source, id: branchedId });
    this.host.alert({ variant: "success", title: "Branched session", body: "New messages go to the branch; the original session is unchanged." });
  }

  /** `/branch <id>`: an exact id or a unique prefix from the session list. */
  async branchById(id: string): Promise<void> {
    const session = await this.findSession(id);
    if (session) await this.branch(session.id);
  }

  /** `/sessions <id>`: an exact id or a unique prefix. */
  private async resumeById(id: string): Promise<void> {
    const session = await this.findSession(id);
    if (session) this.host.resumeSession(session);
  }

  /** Reload the list and match an exact id or a unique prefix; alerts and returns undefined otherwise. */
  private async findSession(id: string): Promise<SessionRecord | undefined> {
    this.sessions = await this.host.cli.sessions();
    const exact = this.sessions.find((session) => session.id === id);
    const matches = exact ? [exact] : this.sessions.filter((session) => session.id.startsWith(id));
    if (matches.length === 1 && matches[0]) return matches[0];
    this.host.alert({ variant: "error", title: matches.length ? `${matches.length} sessions start with ${id}` : `Session not found: ${id}`, body: "Run /sessions to pick from the list." });
    return undefined;
  }

  private usage(text: string): void {
    this.host.alert({ variant: "warning", title: "Usage", body: text });
  }

  private async insertPromptCommand(name: string, args: string[] = []): Promise<void> {
    const command = await cliJson<LoadedPromptCommand>(this.host.cli, ["command", "show", name, "--json", ...(args.length ? ["--arg", ...args] : [])], { content: "" });
    const content = command.content.trim();
    if (!content) throw new Error(`Prompt command is empty: ${name}`);
    if (command.missingArguments?.length) this.host.alert({ variant: "warning", title: "Missing command arguments", body: command.missingArguments.join(", ") });
    this.host.setComposerDraft(content);
  }

  private async setProfile(profile: TuiState["integrationProfile"]): Promise<void> {
    const { state } = this.host;
    const stdout = await cliText(this.host.cli, ["profile", "use", profile, "--project"]);
    state.integrationProfile = profile;
    if (profile === "standalone" && state.mode === "plugin") state.mode = "general";
    this.host.alert({ variant: "success", title: `Integration profile: ${profile}`, body: stdout.trim() || undefined });
  }

  private async removeDirectory(directory: string): Promise<void> {
    const { state } = this.host;
    if (this.blockedWhileRunning("changing external directories")) return;
    const target = state.externalDirectories.find((existing) => existing === directory || existing === path.resolve(state.cwd, directory));
    if (!target) return this.host.alert({ variant: "error", title: "External directory is not attached", body: directory });
    if (hasSavedSession(state)) {
      const remaining = await cliJson<unknown>(this.host.cli, ["session", "remove-dir", state.sessionId, target, "--json"], []);
      state.externalDirectories = Array.isArray(remaining) ? remaining.filter((value): value is string => typeof value === "string") : [];
    } else {
      state.externalDirectories = state.externalDirectories.filter((existing) => existing !== target);
    }
    this.host.alert({ variant: "success", title: "External directory removed from this session", body: target });
  }

  private async previewRewind(checkpointId: string): Promise<void> {
    const { state } = this.host;
    if (this.blockedWhileRunning("rewinding")) return;
    if (!hasSavedSession(state)) return this.noSavedSession("rewinding");
    const preview = parsePreview(await cliJson<unknown>(this.host.cli, ["session", "rewind-preview", state.sessionId, checkpointId, "--json"], {}));
    const lines = [
      ...preview.restoreFiles.slice(0, 5).map((file) => `restore ${file}`),
      ...preview.deleteFiles.slice(0, 5).map((file) => `delete ${file}`)
    ];
    this.host.alert({
      variant: preview.deleteFiles.length ? "warning" : "info",
      title: `Rewind ${checkpointId}: restore ${preview.restoreFiles.length} files, delete ${preview.deleteFiles.length}`,
      body: lines.join("\n")
    });
    // Deleting files the agent created is destructive; ask first, defaulting to Cancel.
    if (preview.deleteFiles.length) {
      this.host.openPicker(picker("rewindConfirm", `Rewind deletes ${preview.deleteFiles.length} files`, rewindConfirmItems(checkpointId, preview.deleteFiles.length)));
      return;
    }
    await this.restore(checkpointId);
  }

  private async restore(checkpointId: string): Promise<void> {
    const { state } = this.host;
    if (this.blockedWhileRunning("rewinding") || !hasSavedSession(state)) return;
    const result = parseRewind(await cliJson<unknown>(this.host.cli, ["session", "rewind", state.sessionId, checkpointId, "--json"], {}));
    this.host.alert({ variant: "success", title: `Rewound to ${checkpointId}`, body: `Restored ${result.restoredFiles} files, deleted ${result.deletedFiles} files.` });
  }

  private async handoff(worker: string, prompt?: string): Promise<void> {
    const { state } = this.host;
    if (this.blockedWhileRunning("handing off")) return;
    if (!hasSavedSession(state)) return this.noSavedSession("handing it off");
    const source = state.sessionId;
    this.host.alert({ variant: "info", title: `Handing off ${source} to ${worker}…` });
    const args = ["crew", "handoff", `worker:${worker}`, source, ...(prompt ? [prompt] : []), "--provider", state.provider, "--mode", state.mode, "--effort", state.effort, "--approval", state.fullAccess ? "full-access" : "review"];
    if (state.model) args.push("--model", state.model);
    if (state.systemPrompt) args.push("--system-prompt", state.systemPrompt);
    const result = await cliJson<{ sessionId?: string; worker?: string; summary?: string }>(this.host.cli, [...args, "--json"], {});
    if (!result.sessionId) throw new Error("Handoff completed without a new session id.");
    state.sessionId = result.sessionId;
    state.worker = result.worker ?? worker;
    state.changedFiles = [];
    this.host.alert({ variant: "success", title: "Handoff complete", body: `${source} → ${result.sessionId} as ${state.worker}` });
    if (result.summary) this.host.push({ type: "assistant", text: result.summary });
  }

  private blockedWhileRunning(action: string): boolean {
    if (!this.host.bridgeRunning && !this.host.state.running) return false;
    this.host.alert({ variant: "warning", title: `Wait for the current run to finish before ${action}`, body: "Use /stop to end it." });
    return true;
  }

  private noSavedSession(action: string): void {
    this.host.alert({ variant: "warning", title: `Start or resume a saved session before ${action}` });
  }
}

function hasSavedSession(state: TuiState): boolean {
  return Boolean(state.sessionId) && state.sessionId !== "new";
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function parsePreview(value: unknown): RewindPreview {
  const fields = record(value);
  return { restoreFiles: stringList(fields.restoreFiles), deleteFiles: stringList(fields.deleteFiles) };
}

function parseRewind(value: unknown): RewindResult {
  const fields = record(value);
  return {
    restoredFiles: typeof fields.restoredFiles === "number" ? fields.restoredFiles : 0,
    deletedFiles: typeof fields.deletedFiles === "number" ? fields.deletedFiles : 0
  };
}
