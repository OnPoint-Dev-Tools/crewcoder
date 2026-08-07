import type { AgentEventSink } from "./events.js";
import { assignAssistantHashes } from "./message-hash.js";
import type { ModelClient } from "./model-client.js";
import { createSessionId, loadSessionRecord, saveSession, type SessionRecord } from "./session-store.js";
import { emptyUsageSummary } from "./usage.js";

export type ReplayResult = { sourceSessionId: string; sourceTurn: number; sessionId: string; promptHash: string; originalResponseHash: string; replayResponseHash: string; matched: boolean; sessionFile: string };

export async function replaySessionTurn(input: { sessionId: string; turn: number; modelClient: ModelClient; providerId?: string; model?: string; emit?: AgentEventSink }): Promise<ReplayResult> {
  if (!Number.isInteger(input.turn) || input.turn < 1) throw new Error("Replay turn must be a positive integer");
  const source = await loadSessionRecord(input.sessionId);
  const turn = source.modelTurns?.find((item) => item.iteration === input.turn);
  if (!turn) throw new Error(`Session ${input.sessionId} has no reproducible model input for turn ${input.turn}`);
  const sessionId = createSessionId();
  await input.emit?.({ type: "agent_start", sessionId });
  await input.emit?.({ type: "provider_start", providerId: input.providerId ?? source.provider ?? "unknown", model: input.model ?? source.model });
  const response = assignAssistantHashes(await input.modelClient.complete(turn.input), turn.input);
  await input.emit?.({ type: "provider_end", providerId: input.providerId ?? source.provider ?? "unknown", model: input.model ?? source.model });
  await input.emit?.({ type: "message_start", message: response });
  await input.emit?.({ type: "message_end", message: response });
  const record: SessionRecord = {
    id: sessionId,
    startedAt: new Date().toISOString(),
    cwd: source.cwd,
    requestedMode: source.requestedMode,
    resolvedMode: source.resolvedMode,
    prompt: `[replay ${source.id} turn ${input.turn}]`,
    provider: input.providerId ?? source.provider,
    model: input.model ?? source.model,
    parentSessionId: source.id,
    events: [],
    messages: [...turn.input.messages, response],
    modelTurns: [{ iteration: 1, input: turn.input, promptHash: response.promptHash ?? "", responseHash: response.responseHash ?? "", responseId: response.id ?? "" }],
    mutationLog: [],
    usage: emptyUsageSummary()
  };
  await input.emit?.({ type: "agent_end", sessionId, messages: record.messages });
  const sessionFile = await saveSession(record);
  await input.emit?.({ type: "session_saved", sessionId, path: sessionFile });
  return { sourceSessionId: source.id, sourceTurn: input.turn, sessionId, promptHash: turn.promptHash, originalResponseHash: turn.responseHash, replayResponseHash: response.responseHash ?? "", matched: turn.responseHash === response.responseHash, sessionFile };
}
