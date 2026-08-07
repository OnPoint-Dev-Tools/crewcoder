import type { ApprovalMode } from "./approval.js";
import type { AgentEvent } from "./events.js";
import type { AgentMode } from "./types.js";

export const FLEET_PROTOCOL_VERSION = "1.0" as const;

export type FleetRunStatus = "running" | "completed" | "failed" | "aborted";

export type FleetRunRequest = {
  prompt?: string;
  sessionId?: string;
  mode?: AgentMode;
  provider?: string;
  model?: string;
  worker?: string;
  systemPrompt?: string;
  effort?: string;
  cwd?: string;
  approval?: ApprovalMode;
  maxIterations?: number;
  heuristic?: boolean;
};

export type FleetRunSummary = {
  runId: string;
  status: FleetRunStatus;
  sessionId?: string;
  error?: string;
  eventCount: number;
  lastEventId: number;
  createdAt: string;
  updatedAt: string;
};

export type FleetProtocolEvent =
  | { type: "fleet_run_created"; runId: string; status: FleetRunStatus }
  | { type: "fleet_run_status"; runId: string; status: FleetRunStatus; sessionId?: string; error?: string; interrupted?: boolean };

export type FleetEvent = AgentEvent | FleetProtocolEvent;

export type FleetEventRecord = {
  id: number;
  emittedAt: string;
  event: FleetEvent;
};
