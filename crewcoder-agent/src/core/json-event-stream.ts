import type { AgentEvent, AgentEventSink } from "./events.js";

export function createJsonEventSink(write: (line: string) => void = (line) => process.stdout.write(line + "\n")): AgentEventSink {
  return (event: AgentEvent) => {
    write(JSON.stringify({ ...event, emittedAt: new Date().toISOString() }));
  };
}
