import type { AgentEvent, AgentEventSink } from "./events.js";

export function createJsonEventSink(write: (line: string) => void = (line) => process.stdout.write(line + "\n")): AgentEventSink {
  return (event: AgentEvent) => {
    // Commentary already travels as thinking text here; ACP still publishes dialogue for host gates.
    if (event.type === "assistant_delta" && event.phase === "commentary") return;
    // Terminal clients consume text deltas; ACP carries authoritative progress snapshots separately.
    if (event.type === "thinking_delta") {
      if (!event.text) return;
      write(JSON.stringify({ type: event.type, text: event.text, emittedAt: new Date().toISOString() }));
      return;
    }
    write(JSON.stringify({ ...event, emittedAt: new Date().toISOString() }));
  };
}
