import { getText } from "./messages.js";
import { listAllSessions } from "./session-store.js";

export type SessionSearchMatch = { sessionId: string; startedAt: string; cwd: string; role: string; messageIndex: number; messageId?: string; promptHash?: string; responseHash?: string; snippet: string };

export async function searchSessions(query: string): Promise<SessionSearchMatch[]> {
  const needle = query.trim().toLowerCase();
  if (!needle) throw new Error("Search query is required");
  const sessions = await listAllSessions();
  const matches: SessionSearchMatch[] = [];
  for (const session of sessions) {
    session.messages.forEach((message, messageIndex) => {
      const text = getText(message);
      const assistant = message.role === "assistant" ? message : undefined;
      const searchable = [text, assistant?.id, assistant?.promptHash, assistant?.responseHash].filter(Boolean).join("\n");
      const index = searchable.toLowerCase().indexOf(needle);
      if (index < 0) return;
      const textIndex = Math.max(0, text.toLowerCase().indexOf(needle));
      const start = Math.max(0, textIndex - 80);
      const snippet = text ? `${start > 0 ? "…" : ""}${text.slice(start, start + 240).replace(/\s+/g, " ").trim()}${start + 240 < text.length ? "…" : ""}` : searchable.slice(Math.max(0, index - 40), index + needle.length + 80);
      matches.push({ sessionId: session.id, startedAt: session.startedAt, cwd: session.cwd, role: message.role, messageIndex, messageId: assistant?.id, promptHash: assistant?.promptHash, responseHash: assistant?.responseHash, snippet });
    });
  }
  return matches;
}
