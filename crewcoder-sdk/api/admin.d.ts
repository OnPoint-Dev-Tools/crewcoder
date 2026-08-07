import { type AgentMode, type ApprovalMode, type CrewCodeProjectDetection, type CrewCoderConfig, type CrewCoderConfigSetKey, type ExtensionInstallResult, type GoalRecord, type InstallExtensionOptions, type IntegrationProfile, type LoadedCrewCoderExtension, type MemoryEntry, type RegistrySearchOptions, type RegistrySearchResult, type SessionCheckpoint, type SessionCheckpointPreview, type SessionListOptions, type SessionRecord, type SessionRewindResult, type SessionSummary, type TrustTier, type UninstallResult } from "@onpoint-dev-tools/crewcoder-agent";
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
export declare class CrewCoderConfigAdmin {
    get(): CrewCoderConfig;
    set(key: CrewCoderConfigSetKey, value: string): CrewCoderConfig;
}
export declare class CrewCoderProfileAdmin {
    private readonly cwd;
    constructor(cwd: string);
    get(): CrewCoderProfileState;
    use(profile: IntegrationProfile, scope?: CrewCoderProfileScope): CrewCoderProfileState;
    detect(): CrewCodeProjectDetection;
    dismiss(): CrewCodeProjectDetection;
}
export declare class CrewCoderExtensionAdmin {
    list(): Promise<LoadedCrewCoderExtension[]>;
    inspect(id: string): Promise<LoadedCrewCoderExtension | undefined>;
    install(spec: string, options?: InstallExtensionOptions): Promise<ExtensionInstallResult>;
    update(id: string, options?: {
        force?: boolean;
    }): Promise<ExtensionInstallResult>;
    remove(id: string): Promise<UninstallResult>;
    setEnabled(id: string, enabled: boolean): void;
    setTrust(id: string, tier: TrustTier): TrustTier;
    getTrust(id: string): TrustTier;
    search(query: string, options?: RegistrySearchOptions): Promise<RegistrySearchResult>;
    registries(): string[];
    addRegistry(url: string): string[];
    removeRegistry(url: string): {
        removed: boolean;
        registries: string[];
    };
}
export declare class CrewCoderGoalAdmin {
    private readonly cwd;
    constructor(cwd: string);
    list(options?: {
        all?: boolean;
    }): Promise<GoalRecord[]>;
    current(): Promise<GoalRecord | undefined>;
    get(goalId: string): Promise<GoalRecord>;
    start(objective: string, options?: CrewCoderGoalStartOptions): Promise<GoalRecord>;
    pause(goalId?: string, reason?: string): Promise<GoalRecord>;
    resume(goalId?: string, options?: {
        approval?: ApprovalMode;
    }): Promise<GoalRecord>;
    approve(goalId: string | undefined, approved: boolean, reason?: string): Promise<GoalRecord>;
    cancel(goalId?: string): Promise<GoalRecord>;
}
export declare class CrewCoderMemoryAdmin {
    private readonly cwd;
    constructor(cwd: string);
    status(): CrewCoderMemoryStatus;
    setEnabled(enabled: boolean): CrewCoderMemoryStatus;
    remember(text: string, options?: {
        topic?: string;
    }): MemoryEntry;
    list(): MemoryEntry[];
    context(): string | null;
    forget(id: string): MemoryEntry | null;
}
export declare class CrewCoderSessionAdmin {
    private readonly cwd;
    constructor(cwd: string);
    list(options?: SessionListOptions): Promise<SessionSummary[]>;
    get(sessionId: string): Promise<SessionRecord>;
    branch(sessionId: string): Promise<SessionRecord>;
    delete(sessionId: string): Promise<boolean>;
    checkpoints(sessionId: string): Promise<SessionCheckpoint[]>;
    previewRewind(sessionId: string, checkpointId: string): Promise<SessionCheckpointPreview>;
    rewind(sessionId: string, checkpointId: string, options: CrewCoderRewindOptions): Promise<SessionRewindResult>;
}
export declare class CrewCoderAdmin {
    readonly config: CrewCoderConfigAdmin;
    readonly extensions: CrewCoderExtensionAdmin;
    readonly goals: CrewCoderGoalAdmin;
    readonly memory: CrewCoderMemoryAdmin;
    readonly profiles: CrewCoderProfileAdmin;
    readonly sessions: CrewCoderSessionAdmin;
    readonly cwd: string;
    constructor(options?: CrewCoderAdminOptions);
}
//# sourceMappingURL=admin.d.ts.map