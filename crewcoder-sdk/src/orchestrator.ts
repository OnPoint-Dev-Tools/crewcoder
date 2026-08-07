import {
  getCrewCoderWorkerTeam,
  handoffCrewCoderSession,
  listCrewCoderWorkerTeams,
  runCrewCoderCrew,
  runCrewCoderTeam,
  type AgentEvent,
  type CrewCoderWorkerRuntimeOptions,
  type WorkerCrewRunResult,
  type WorkerHandoffResult,
  type WorkerTeam,
  type WorkerTeamsManifest
} from "@crewcode/crewcoder-agent";

export type CrewCoderOrchestratorOptions = Omit<CrewCoderWorkerRuntimeOptions, "emit">;
export type CrewCoderOrchestratorEventListener = (event: AgentEvent) => Promise<void> | void;
export type CrewCoderCrewInput = { prompt: string; workers: string[]; workerPrompts?: Record<string, string> };
export type CrewCoderTeamInput = { prompt: string; teamId: string };
export type CrewCoderHandoffInput = { sessionId: string; worker: string; prompt?: string };

export class CrewCoderOrchestrator {
  private readonly options: CrewCoderOrchestratorOptions;
  private readonly listeners = new Set<CrewCoderOrchestratorEventListener>();
  private readonly approvalSignal: { decisions: Array<{ approvalId: string; approved: boolean; reason?: string }> } = { decisions: [] };
  private abortController: AbortController | undefined;
  private running = false;

  constructor(options: CrewCoderOrchestratorOptions = {}) {
    this.options = { ...options };
  }

  get isRunning(): boolean {
    return this.running;
  }

  subscribe(listener: CrewCoderOrchestratorEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  listTeams(): WorkerTeamsManifest | null {
    return listCrewCoderWorkerTeams(this.options.cwd);
  }

  getTeam(teamId: string): WorkerTeam {
    return getCrewCoderWorkerTeam(teamId, this.options.cwd);
  }

  runCrew(input: CrewCoderCrewInput): Promise<WorkerCrewRunResult> {
    return this.run((runtime) => runCrewCoderCrew({ ...runtime, ...input }));
  }

  runTeam(input: CrewCoderTeamInput): Promise<WorkerCrewRunResult> {
    return this.run((runtime) => runCrewCoderTeam({ ...runtime, ...input }));
  }

  handoff(input: CrewCoderHandoffInput): Promise<WorkerHandoffResult> {
    return this.run((runtime) => handoffCrewCoderSession({ ...runtime, ...input }));
  }

  approve(approvalId: string, approved: boolean, reason?: string): boolean {
    if (!this.running || !approvalId.trim()) return false;
    this.approvalSignal.decisions.push({
      approvalId: approvalId.trim(),
      approved,
      ...(reason?.trim() ? { reason: reason.trim() } : {})
    });
    return true;
  }

  abort(): boolean {
    if (!this.abortController) return false;
    this.abortController.abort();
    return true;
  }

  private async run<TResult>(operation: (runtime: CrewCoderWorkerRuntimeOptions) => Promise<TResult>): Promise<TResult> {
    if (this.running) throw new Error("CrewCoderOrchestrator is already running.");
    this.running = true;
    this.abortController = new AbortController();
    const signal = this.options.signal
      ? AbortSignal.any([this.options.signal, this.abortController.signal])
      : this.abortController.signal;
    try {
      return await operation({
        ...this.options,
        signal,
        approvalSignal: this.approvalSignal,
        emit: async (event) => {
          for (const listener of [...this.listeners]) await listener(event);
        }
      });
    } finally {
      this.running = false;
      this.abortController = undefined;
      this.approvalSignal.decisions.length = 0;
    }
  }
}

export function createCrewCoderOrchestrator(options: CrewCoderOrchestratorOptions = {}): CrewCoderOrchestrator {
  return new CrewCoderOrchestrator(options);
}
