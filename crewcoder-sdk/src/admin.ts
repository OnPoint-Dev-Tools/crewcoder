import path from "node:path";
import {
  addRegistry,
  clearGoal,
  createSessionBranch,
  currentGoal,
  decideGoalApproval,
  deleteSessionRecord,
  detectCrewCodeProject,
  forgetMemory,
  getExtensionTrustTier,
  getSessionRecord,
  inspectExtension,
  installExtension,
  isProjectMemoryEnabled,
  listConfiguredRegistries,
  listGoals,
  listMemories,
  listSessionCheckpointRecords,
  listSessionSummaries,
  loadCrewCoderExtensions,
  pauseGoal,
  previewSessionRewind,
  readConfig,
  readMemoryContext,
  readProjectIntegrationProfile,
  refreshGoal,
  rememberFact,
  removeRegistry,
  resolveIntegrationProfile,
  resumeGoal,
  rewindSessionToCheckpoint,
  searchRegistries,
  setConfigValue,
  setCrewCodeProfilePromptDismissed,
  setExtensionEnabled,
  setExtensionTrustTier,
  setProjectIntegrationProfile,
  setProjectMemoryEnabled,
  startGoal,
  uninstallExtension,
  updateExtension,
  type AgentMode,
  type ApprovalMode,
  type CrewCodeProjectDetection,
  type CrewCoderConfig,
  type CrewCoderConfigSetKey,
  type ExtensionInstallResult,
  type GoalRecord,
  type InstallExtensionOptions,
  type IntegrationProfile,
  type LoadedCrewCoderExtension,
  type MemoryEntry,
  type RegistrySearchOptions,
  type RegistrySearchResult,
  type SessionCheckpoint,
  type SessionCheckpointPreview,
  type SessionListOptions,
  type SessionRecord,
  type SessionRewindResult,
  type SessionSummary,
  type TrustTier,
  type UninstallResult
} from "@crewcode/crewcoder-agent";

export type CrewCoderAdminOptions = {
  /** Project root used for project-scoped profile settings. Defaults to process.cwd(). */
  cwd?: string;
};

export type CrewCoderProfileState = {
  effective: IntegrationProfile;
  source: "project" | "user";
  project?: IntegrationProfile;
  user: IntegrationProfile;
};

export type CrewCoderProfileScope = "project" | "user";

export type CrewCoderGoalStartOptions = {
  provider?: string;
  model?: string;
  mode?: AgentMode;
  effort?: string;
  approval?: ApprovalMode;
  tokenBudget?: number;
  maxTurns?: number;
  checkModel?: string;
  timeoutMinutes?: number;
  systemPrompt?: string;
  worker?: string;
};

export type CrewCoderMemoryStatus = {
  enabled: boolean;
};

export type CrewCoderRewindOptions = {
  /** Required acknowledgement because rewind overwrites and deletes workspace files. */
  confirm: true;
};

export class CrewCoderConfigAdmin {
  get(): CrewCoderConfig {
    return readConfig();
  }

  set(key: CrewCoderConfigSetKey, value: string): CrewCoderConfig {
    return setConfigValue(key, value);
  }
}

export class CrewCoderProfileAdmin {
  private readonly cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  get(): CrewCoderProfileState {
    const config = readConfig();
    const project = readProjectIntegrationProfile(this.cwd);
    return {
      effective: resolveIntegrationProfile(this.cwd, config),
      source: project ? "project" : "user",
      ...(project ? { project } : {}),
      user: config.integrationProfile
    };
  }

  use(profile: IntegrationProfile, scope: CrewCoderProfileScope = "project"): CrewCoderProfileState {
    if (scope === "project") setProjectIntegrationProfile(this.cwd, profile);
    else setConfigValue("integrationProfile", profile);
    return this.get();
  }

  detect(): CrewCodeProjectDetection {
    return detectCrewCodeProject(this.cwd);
  }

  dismiss(): CrewCodeProjectDetection {
    setCrewCodeProfilePromptDismissed(this.cwd, true);
    return this.detect();
  }
}

export class CrewCoderExtensionAdmin {
  list(): Promise<LoadedCrewCoderExtension[]> { return loadCrewCoderExtensions(); }
  inspect(id: string): Promise<LoadedCrewCoderExtension | undefined> { return inspectExtension(id); }
  install(spec: string, options: InstallExtensionOptions = {}): Promise<ExtensionInstallResult> { return installExtension(spec, options); }
  update(id: string, options: { force?: boolean } = {}): Promise<ExtensionInstallResult> { return updateExtension(id, options); }
  remove(id: string): Promise<UninstallResult> { return uninstallExtension(id); }
  setEnabled(id: string, enabled: boolean): void { setExtensionEnabled(id, enabled); }
  setTrust(id: string, tier: TrustTier): TrustTier { setExtensionTrustTier(id, tier); return getExtensionTrustTier(id); }
  getTrust(id: string): TrustTier { return getExtensionTrustTier(id); }
  search(query: string, options: RegistrySearchOptions = {}): Promise<RegistrySearchResult> { return searchRegistries(query, options); }
  registries(): string[] { return listConfiguredRegistries(); }
  addRegistry(url: string): string[] { return addRegistry(url); }
  removeRegistry(url: string): { removed: boolean; registries: string[] } { return removeRegistry(url); }
}

export class CrewCoderGoalAdmin {
  private readonly cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  list(options: { all?: boolean } = {}): Promise<GoalRecord[]> {
    return listGoals(options.all ? undefined : this.cwd);
  }

  current(): Promise<GoalRecord | undefined> {
    return currentGoal(this.cwd);
  }

  async get(goalId: string): Promise<GoalRecord> {
    return refreshGoal(goalId, this.cwd);
  }

  start(objective: string, options: CrewCoderGoalStartOptions = {}): Promise<GoalRecord> {
    const config = readConfig();
    return startGoal({
      objective,
      cwd: this.cwd,
      provider: options.provider ?? config.defaultProvider,
      model: options.model ?? config.defaultModel ?? "",
      mode: options.mode ?? config.defaultMode,
      approvalMode: options.approval ?? "review",
      effort: options.effort,
      tokenBudget: options.tokenBudget,
      maxTurns: options.maxTurns ?? config.goals.maxTurns,
      checkModel: options.checkModel ?? config.goals.checkModel,
      timeoutMinutes: options.timeoutMinutes ?? config.goals.timeoutMinutes,
      systemPromptName: options.systemPrompt,
      workerName: options.worker
    });
  }

  pause(goalId?: string, reason?: string): Promise<GoalRecord> {
    return pauseGoal(goalId, { cwd: this.cwd, reason });
  }

  resume(goalId?: string, options: { approval?: ApprovalMode } = {}): Promise<GoalRecord> {
    return resumeGoal(goalId, { cwd: this.cwd, approvalMode: options.approval });
  }

  approve(goalId: string | undefined, approved: boolean, reason?: string): Promise<GoalRecord> {
    return decideGoalApproval(goalId, approved, { cwd: this.cwd, reason });
  }

  cancel(goalId?: string): Promise<GoalRecord> {
    return clearGoal(goalId, { cwd: this.cwd });
  }
}

export class CrewCoderMemoryAdmin {
  private readonly cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  status(): CrewCoderMemoryStatus {
    return { enabled: isProjectMemoryEnabled(this.cwd) };
  }

  setEnabled(enabled: boolean): CrewCoderMemoryStatus {
    setProjectMemoryEnabled(this.cwd, enabled);
    return this.status();
  }

  remember(text: string, options: { topic?: string } = {}): MemoryEntry {
    return rememberFact(this.cwd, text, options);
  }

  list(): MemoryEntry[] {
    return listMemories(this.cwd);
  }

  context(): string | null {
    return readMemoryContext(this.cwd);
  }

  forget(id: string): MemoryEntry | null {
    return forgetMemory(this.cwd, id);
  }
}

export class CrewCoderSessionAdmin {
  private readonly cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  list(options: SessionListOptions = { cwd: this.cwd }): Promise<SessionSummary[]> {
    return listSessionSummaries(options);
  }

  get(sessionId: string): Promise<SessionRecord> {
    return getSessionRecord(sessionId);
  }

  branch(sessionId: string): Promise<SessionRecord> {
    return createSessionBranch(sessionId);
  }

  delete(sessionId: string): Promise<boolean> {
    return deleteSessionRecord(sessionId);
  }

  checkpoints(sessionId: string): Promise<SessionCheckpoint[]> {
    return listSessionCheckpointRecords(sessionId);
  }

  previewRewind(sessionId: string, checkpointId: string): Promise<SessionCheckpointPreview> {
    return previewSessionRewind(sessionId, checkpointId, this.cwd);
  }

  rewind(sessionId: string, checkpointId: string, options: CrewCoderRewindOptions): Promise<SessionRewindResult> {
    if (options?.confirm !== true) throw new Error("Session rewind requires { confirm: true } after reviewing previewRewind().");
    return rewindSessionToCheckpoint(sessionId, checkpointId, this.cwd);
  }
}

export class CrewCoderAdmin {
  readonly config: CrewCoderConfigAdmin;
  readonly extensions: CrewCoderExtensionAdmin;
  readonly goals: CrewCoderGoalAdmin;
  readonly memory: CrewCoderMemoryAdmin;
  readonly profiles: CrewCoderProfileAdmin;
  readonly sessions: CrewCoderSessionAdmin;
  readonly cwd: string;

  constructor(options: CrewCoderAdminOptions = {}) {
    this.cwd = path.resolve(options.cwd ?? process.cwd());
    this.config = new CrewCoderConfigAdmin();
    this.extensions = new CrewCoderExtensionAdmin();
    this.goals = new CrewCoderGoalAdmin(this.cwd);
    this.memory = new CrewCoderMemoryAdmin(this.cwd);
    this.profiles = new CrewCoderProfileAdmin(this.cwd);
    this.sessions = new CrewCoderSessionAdmin(this.cwd);
  }
}
