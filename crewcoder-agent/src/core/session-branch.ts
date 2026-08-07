import { createSessionId, saveSession, type SessionRecord } from "./session-store.js";
import { loadSession } from "./session-loader.js";

export async function branchSession(sessionId: string): Promise<SessionRecord> {
  const original = await loadSession(sessionId);
  const next: SessionRecord = {
    ...original,
    id: createSessionId(),
    startedAt: new Date().toISOString(),
    parentSessionId: original.id,
    prompt: `[branch of ${sessionId}] ${original.prompt}`
  };
  await saveSession(next);
  return next;
}
