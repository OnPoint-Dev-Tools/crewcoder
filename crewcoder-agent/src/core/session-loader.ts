import { ensureCrewCoderHome } from "./crewcoder-home.js";
import { loadSessionRecord, type SessionRecord } from "./session-store.js";

export async function loadSession(sessionId: string): Promise<SessionRecord> {
  ensureCrewCoderHome();
  return loadSessionRecord(sessionId);
}
