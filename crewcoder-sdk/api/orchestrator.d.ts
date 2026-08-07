import { type AgentEvent, type CrewCoderWorkerRuntimeOptions, type WorkerCrewRunResult, type WorkerHandoffResult, type WorkerTeam, type WorkerTeamsManifest } from "@onpoint-dev-tools/crewcoder-agent";
export type CrewCoderOrchestratorOptions = Omit<CrewCoderWorkerRuntimeOptions, "emit">;
export type CrewCoderOrchestratorEventListener = (event: AgentEvent) => Promise<void> | void;
export type CrewCoderCrewInput = {
    prompt: string;
    workers: string[];
    workerPrompts?: Record<string, string>;
};
export type CrewCoderTeamInput = {
    prompt: string;
    teamId: string;
};
export type CrewCoderHandoffInput = {
    sessionId: string;
    worker: string;
    prompt?: string;
};
export declare class CrewCoderOrchestrator {
    private readonly options;
    private readonly listeners;
    private readonly approvalSignal;
    private abortController;
    private running;
    constructor(options?: CrewCoderOrchestratorOptions);
    get isRunning(): boolean;
    subscribe(listener: CrewCoderOrchestratorEventListener): () => void;
    listTeams(): WorkerTeamsManifest | null;
    getTeam(teamId: string): WorkerTeam;
    runCrew(input: CrewCoderCrewInput): Promise<WorkerCrewRunResult>;
    runTeam(input: CrewCoderTeamInput): Promise<WorkerCrewRunResult>;
    handoff(input: CrewCoderHandoffInput): Promise<WorkerHandoffResult>;
    approve(approvalId: string, approved: boolean, reason?: string): boolean;
    abort(): boolean;
    private run;
}
export declare function createCrewCoderOrchestrator(options?: CrewCoderOrchestratorOptions): CrewCoderOrchestrator;
//# sourceMappingURL=orchestrator.d.ts.map