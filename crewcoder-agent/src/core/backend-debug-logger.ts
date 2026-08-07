import fs from "node:fs";
import path from "node:path";
import { ensureCrewCoderHome } from "./crewcoder-home.js";
import type { AgentEventSink } from "./events.js";

export type BackendDebugLevel = "debug" | "info" | "warn" | "error";

export type BackendDebugEvent = {
  type: "backend_debug";
  timestamp: string;
  level: BackendDebugLevel;
  source: string;
  message: string;
  details?: Record<string, unknown>;
};

export type BackendDebugLogger = {
  logPath: string;
  event(event: Omit<BackendDebugEvent, "type" | "timestamp">): Promise<void>;
};

export function createBackendDebugLogger(options: {
  emit?: AgentEventSink;
  stderr?: boolean;
  runId?: string;
} = {}): BackendDebugLogger {
  const home = ensureCrewCoderHome();
  const runId = sanitizeRunId(options.runId ?? new Date().toISOString());
  const logPath = path.join(home.logsDir, `backend-${runId}.jsonl`);

  return {
    logPath,
    async event(event) {
      const debugEvent: BackendDebugEvent = {
        type: "backend_debug",
        timestamp: new Date().toISOString(),
        ...event
      };
      const line = JSON.stringify(debugEvent);
      fs.appendFileSync(logPath, `${line}\n`, "utf8");
      if (options.stderr) process.stderr.write(`[crewcoder:${event.source}] ${event.message}\n`);
      await options.emit?.(debugEvent);
    }
  };
}

function sanitizeRunId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "run";
}
