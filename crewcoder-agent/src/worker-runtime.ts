import { readConfig } from "./core/config.js";
import type { AgentEventSink } from "./core/events.js";
import { HeuristicModelClient, type ModelClient } from "./core/model-client.js";
import type { ApprovalMode } from "./core/approval.js";
import type { AgentMode } from "./core/types.js";
import { handoffToWorker, runWorkerCrew, type WorkerCrewRunResult, type WorkerHandoffResult } from "./core/worker-crews.js";
import { buildTeamPrompt, loadWorkerTeams, resolveWorkerTeam, teamWorkerNames, type WorkerTeam, type WorkerTeamsManifest } from "./core/worker-teams.js";
import { ProviderModelClient } from "./providers/provider-model-client.js";
import { resolveModel } from "./providers/model-registry.js";

export type CrewCoderWorkerRuntimeOptions = {
  cwd?: string;
  mode?: AgentMode;
  provider?: string;
  model?: string;
  effort?: string;
  approval?: ApprovalMode;
  maxIterations?: number;
  systemPrompt?: string;
  modelClient?: ModelClient;
  heuristic?: boolean;
  emit?: AgentEventSink;
  signal?: AbortSignal;
  approvalSignal?: { decisions: Array<{ approvalId: string; approved: boolean; reason?: string }> };
};

export type CrewCoderCrewRuntimeInput = CrewCoderWorkerRuntimeOptions & {
  prompt: string;
  workers: string[];
  workerPrompts?: Record<string, string>;
};

export type CrewCoderTeamRuntimeInput = CrewCoderWorkerRuntimeOptions & {
  prompt: string;
  teamId: string;
};

export type CrewCoderHandoffRuntimeInput = CrewCoderWorkerRuntimeOptions & {
  sessionId: string;
  worker: string;
  prompt?: string;
};

export function listCrewCoderWorkerTeams(cwd = process.cwd()): WorkerTeamsManifest | null {
  return loadWorkerTeams(cwd);
}

export function getCrewCoderWorkerTeam(teamId: string, cwd = process.cwd()): WorkerTeam {
  return resolveWorkerTeam(teamId, cwd);
}

export async function runCrewCoderCrew(input: CrewCoderCrewRuntimeInput): Promise<WorkerCrewRunResult> {
  if (!input.prompt.trim()) throw new Error("Crew prompt cannot be empty.");
  if (!input.workers.length) throw new Error("Crew requires at least one worker.");
  const runtime = await resolveRuntime(input);
  return runWorkerCrew({
    prompt: input.prompt.trim(),
    workers: input.workers,
    workerPrompts: input.workerPrompts,
    requestedMode: runtime.mode,
    cwd: runtime.cwd
  }, runtime.options);
}

export async function runCrewCoderTeam(input: CrewCoderTeamRuntimeInput): Promise<WorkerCrewRunResult> {
  const cwd = input.cwd ?? process.cwd();
  const team = resolveWorkerTeam(input.teamId, cwd);
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("Team prompt cannot be empty.");
  return runCrewCoderCrew({
    ...input,
    cwd,
    prompt,
    workers: teamWorkerNames(team),
    workerPrompts: Object.fromEntries(team.roles.map((role) => [role.worker, buildTeamPrompt(team, prompt, role)]))
  });
}

export async function handoffCrewCoderSession(input: CrewCoderHandoffRuntimeInput): Promise<WorkerHandoffResult> {
  const runtime = await resolveRuntime(input);
  return handoffToWorker({
    sessionId: input.sessionId,
    workerRef: `worker:${input.worker}`,
    prompt: input.prompt,
    requestedMode: input.mode,
    cwd: runtime.cwd
  }, runtime.options);
}

async function resolveRuntime(input: CrewCoderWorkerRuntimeOptions): Promise<{
  cwd: string;
  mode: AgentMode;
  options: Parameters<typeof runWorkerCrew>[1];
}> {
  const config = readConfig();
  const cwd = input.cwd ?? process.cwd();
  const providerId = input.provider ?? process.env.CREWCODER_PROVIDER ?? config.defaultProvider;
  const requestedModel = input.model ?? process.env.CREWCODER_MODEL ?? config.defaultModel;
  const resolved = input.modelClient || input.heuristic ? undefined : await resolveModel(providerId, requestedModel);
  const model = resolved?.model ?? requestedModel;
  const sharedModelClient = input.modelClient ?? (input.heuristic ? new HeuristicModelClient() : undefined);
  return {
    cwd,
    mode: input.mode ?? config.defaultMode,
    options: {
      providerId,
      model,
      contextWindow: resolved?.metadata?.contextWindow,
      maxIterations: input.maxIterations ?? config.maxIterations,
      approvalMode: input.approval ?? "never",
      systemPromptName: input.systemPrompt,
      signal: input.signal,
      approvalSignal: input.approvalSignal,
      emit: input.emit,
      createModelClient: () => sharedModelClient ?? new ProviderModelClient(providerId, cwd, model, undefined, config.thinkingEnabled ? input.effort : "none")
    }
  };
}
