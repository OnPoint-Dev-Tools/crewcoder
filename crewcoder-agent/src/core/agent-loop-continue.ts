import { runAgentLoop, type AgentLoopOptions, type AgentLoopResult } from "./agent-loop.js";
import { loadSession } from "./session-loader.js";
import { sessionFilePath } from "./session-store.js";
import { inspectProject } from "./repo-inspector.js";
import { resolveMode } from "./mode-router.js";
import { emptyUsageSummary } from "./usage.js";
import type { AgentEvent } from "./events.js";
import type { AgentMode } from "./types.js";

export async function runAgentLoopContinue(input: {
  sessionId: string;
  prompt?: string;
  mode?: AgentMode;
  cwd?: string;
  externalDirectories?: string[];
  images?: string[];
}, options: AgentLoopOptions = {}): Promise<AgentLoopResult> {
  const session = await loadSession(input.sessionId);
  const prompt = input.prompt?.trim();
  const requestedMode = input.mode ?? (session.requestedMode as AgentMode);

  if (!prompt) {
    const cwd = input.cwd ?? session.cwd;
    const project = await inspectProject(cwd);
    const emit = async (event: AgentEvent) => {
      await options.emit?.(event);
    };
    await emit({ type: "agent_start", sessionId: session.id });
    await emit({ type: "agent_end", sessionId: session.id, messages: session.messages });
    return {
      sessionId: session.id,
      mode: resolveMode(requestedMode),
      providerId: options.providerId,
      model: options.model,
      messages: session.messages,
      activatedSkills: [],
      activatedExtensions: [],
      retrievedDocs: [],
      mutationLog: session.mutationLog,
      externalDirectories: session.externalDirectories ?? [],
      usage: session.usage ?? emptyUsageSummary(),
      project,
      compactions: session.compactions ?? [],
      checkpoints: session.checkpoints ?? [],
      modelTurns: session.modelTurns ?? [],
      providerSessionIds: session.providerSessionIds ?? {},
      extensionEntries: session.extensionEntries ?? [],
      sessionFile: sessionFilePath(session.id),
      summary: "",
      notes: [],
      budgetExceeded: session.usage?.budgetExceeded ?? false
    };
  }

  return runAgentLoop({
    prompt,
    requestedMode,
    cwd: input.cwd ?? session.cwd,
    externalDirectories: input.externalDirectories ?? session.externalDirectories,
    images: input.images
  }, {
    ...options,
    sessionId: input.sessionId,
    resumeFromSessionId: input.sessionId,
    resumeContext: session.pendingResumeContext,
    initialMessages: session.messages,
    initialMutationLog: session.mutationLog,
    initialUsage: session.usage,
    initialCompactions: session.compactions,
    initialCheckpoints: session.checkpoints,
    initialModelTurns: session.modelTurns,
    initialProviderSessionIds: session.providerSessionIds,
    initialExtensionEntries: session.extensionEntries
  });
}
