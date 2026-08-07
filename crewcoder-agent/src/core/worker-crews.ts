import { runAgentLoop, type AgentLoopOptions, type AgentLoopResult } from "./agent-loop.js";
import { loadSession } from "./session-loader.js";
import { createSessionId } from "./session-store.js";
import { resolveActiveWorker } from "./identity.js";
import type { AgentMode } from "./types.js";
import type { ModelClient } from "./model-client.js";

export type WorkerCrewRunInput = {
  prompt: string;
  workers: string[];
  workerPrompts?: Record<string, string>;
  requestedMode: AgentMode;
  cwd: string;
};

export type WorkerCrewRunOptions = Omit<AgentLoopOptions, "workerName" | "sessionId" | "modelClient"> & {
  createModelClient?: (workerName: string) => ModelClient | undefined;
  sessionIdFactory?: (workerName: string) => string;
};

export type WorkerCrewRunResult = {
  prompt: string;
  workers: Array<{ worker: string; sessionId: string; summary: string; mutationLog: string[] }>;
};

export type WorkerHandoffInput = {
  sessionId: string;
  workerRef: string;
  prompt?: string;
  requestedMode?: AgentMode;
  cwd?: string;
};

export type WorkerHandoffOptions = Omit<AgentLoopOptions, "workerName" | "sessionId" | "resumeFromSessionId" | "initialMessages" | "initialMutationLog" | "initialUsage" | "initialCompactions" | "initialCheckpoints" | "initialExtensionEntries"> & {
  createModelClient?: (workerName: string) => ModelClient | undefined;
  sessionIdFactory?: (workerName: string) => string;
};

export type WorkerHandoffResult = AgentLoopResult & {
  sourceSessionId: string;
  worker: string;
};

export function parseWorkerList(value: string): string[] {
  const workers = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (!workers.length) throw new Error("Provide at least one worker name with --workers reviewer,builder.");
  return [...new Set(workers)];
}

export function parseWorkerRef(value: string): string {
  const trimmed = value.trim();
  const prefix = "worker:";
  if (!trimmed.startsWith(prefix) || trimmed.length === prefix.length) {
    throw new Error("Worker handoff target must use worker:<name>.");
  }
  return trimmed.slice(prefix.length);
}

export async function runWorkerCrew(input: WorkerCrewRunInput, options: WorkerCrewRunOptions = {}): Promise<WorkerCrewRunResult> {
  const results: WorkerCrewRunResult["workers"] = [];
  const resolvedWorkers = input.workers.map((workerName) => resolveActiveWorker(workerName));
  await options.emit?.({ type: "crew_start", workers: resolvedWorkers.map((worker) => worker.name) });
  let completed = 0;
  let failed = 0;
  try {
    for (let index = 0; index < resolvedWorkers.length; index++) {
      const worker = resolvedWorkers[index]!;
      const workerName = input.workers[index]!;
      const workerPrompt = input.workerPrompts?.[worker.name] ?? input.workerPrompts?.[workerName] ?? input.prompt;
      const sessionId = options.sessionIdFactory?.(worker.name);
      await options.emit?.({ type: "crew_worker_start", worker: worker.name, index, total: resolvedWorkers.length, sessionId });
      try {
        const result = await runAgentLoop({ prompt: workerPrompt, requestedMode: input.requestedMode, cwd: input.cwd }, {
          ...options,
          workerName: worker.name,
          sessionId,
          modelClient: options.createModelClient?.(worker.name)
        });
        results.push({ worker: worker.name, sessionId: result.sessionId, summary: result.summary, mutationLog: result.mutationLog });
        const failure = result.providerError ?? result.stallError ?? (result.iterationCapReached ? "Explicit iteration cap reached." : undefined);
        if (failure) failed += 1;
        else completed += 1;
        await options.emit?.({ type: "crew_worker_end", worker: worker.name, index, total: resolvedWorkers.length, status: failure ? "failed" : "completed", sessionId: result.sessionId, ...(failure ? { error: failure } : {}) });
      } catch (error) {
        failed += 1;
        await options.emit?.({ type: "crew_worker_end", worker: worker.name, index, total: resolvedWorkers.length, status: "failed", sessionId, error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    }
    return { prompt: input.prompt, workers: results };
  } finally {
    await options.emit?.({ type: "crew_end", total: resolvedWorkers.length, completed, failed });
  }
}

export async function handoffToWorker(input: WorkerHandoffInput, options: WorkerHandoffOptions = {}): Promise<WorkerHandoffResult> {
  const sessionId = input.sessionId.trim();
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error("Session id must contain only letters, numbers, underscores, and hyphens.");
  const workerName = parseWorkerRef(input.workerRef);
  const worker = resolveActiveWorker(workerName);
  const source = await loadSession(sessionId);
  const prompt = input.prompt?.trim() || `Continue this handed-off session as ${worker.name}. Review the prior transcript, preserve the user's intent, and proceed from the current state.`;
  const result = await runAgentLoop({ prompt, requestedMode: input.requestedMode ?? source.requestedMode as AgentMode, cwd: input.cwd ?? source.cwd }, {
    ...options,
    workerName: worker.name,
    sessionId: options.sessionIdFactory?.(worker.name) ?? createSessionId(),
    resumeFromSessionId: source.id,
    resumeContext: `Worker handoff from session ${source.id} to worker ${worker.name}.`,
    initialMessages: source.messages,
    initialMutationLog: source.mutationLog,
    initialUsage: source.usage,
    initialCompactions: source.compactions,
    initialCheckpoints: source.checkpoints,
    initialExtensionEntries: source.extensionEntries,
    modelClient: options.createModelClient?.(worker.name)
  });
  return { ...result, sourceSessionId: source.id, worker: worker.name };
}
