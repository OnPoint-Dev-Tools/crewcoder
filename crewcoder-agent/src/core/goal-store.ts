import fs from "node:fs/promises";
import path from "node:path";
import { ensureCrewCoderHome } from "./crewcoder-home.js";
import type { ApprovalMode } from "./approval.js";
import type { AgentMode } from "./types.js";

export type GoalStatus = "queued" | "running" | "awaiting_approval" | "paused" | "completed" | "failed" | "cancelled";

export type GoalPendingApproval = {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  reason: string;
  args: Record<string, unknown>;
  decision?: { approved: boolean; reason?: string };
};

export type GoalCheckResult = {
  verdict: "continue" | "complete";
  reason: string;
  evidence?: string;
  model: string;
  checkedAt: string;
};

export type GoalProgress = {
  cycle: number;
  startedAt: string;
  endedAt: string;
  sessionId: string;
  summary: string;
  changedFiles: string[];
  check?: GoalCheckResult;
};

export type GoalRecord = {
  version: 1;
  id: string;
  objective: string;
  cwd: string;
  provider: string;
  model: string;
  mode: AgentMode;
  effort?: string;
  approvalMode: ApprovalMode;
  tokenBudget?: number;
  maxTurns?: number;
  checkModel?: string;
  timeoutMinutes?: number;
  systemPromptName?: string;
  workerName?: string;
  status: GoalStatus;
  createdAt: string;
  updatedAt: string;
  pid?: number;
  sessionId?: string;
  cycle: number;
  progress: GoalProgress[];
  pendingApproval?: GoalPendingApproval;
  completionSummary?: string;
  completionEvidence?: string;
  lastCheck?: GoalCheckResult;
  pauseReason?: string;
  error?: string;
};

export type CreateGoalInput = Pick<GoalRecord, "objective" | "cwd" | "provider" | "model" | "mode" | "approvalMode"> &
  Partial<Pick<GoalRecord, "effort" | "tokenBudget" | "maxTurns" | "checkModel" | "timeoutMinutes" | "systemPromptName" | "workerName">>;

export function createGoalId(): string {
  return `goal_${new Date().toISOString().replace(/[:.]/g, "-")}_${Math.random().toString(36).slice(2, 8)}`;
}

export function goalDir(goalId: string): string {
  return path.join(ensureCrewCoderHome().goalsDir, safeGoalId(goalId));
}

export function goalRecordPath(goalId: string): string {
  return path.join(goalDir(goalId), "goal.json");
}

export function goalEventsPath(goalId: string): string {
  return path.join(goalDir(goalId), "events.jsonl");
}

export function goalStdoutPath(goalId: string): string {
  return path.join(goalDir(goalId), "worker.log");
}

export function goalStderrPath(goalId: string): string {
  return path.join(goalDir(goalId), "worker.err.log");
}

export function goalLockPath(goalId: string): string {
  return path.join(goalDir(goalId), "worker.lock");
}

export async function createGoal(input: CreateGoalInput): Promise<GoalRecord> {
  const existing = await currentGoal(input.cwd);
  if (existing && activeGoalStatus(existing.status)) {
    throw new Error(`Goal ${existing.id} is already ${existing.status} in this workspace. Pause or clear it before starting another.`);
  }
  const now = new Date().toISOString();
  const record: GoalRecord = {
    version: 1,
    id: createGoalId(),
    objective: requiredText(input.objective, "Goal objective"),
    cwd: path.resolve(input.cwd),
    provider: requiredText(input.provider, "Goal provider"),
    model: requiredText(input.model, "Goal model"),
    mode: input.mode,
    effort: input.effort,
    approvalMode: input.approvalMode,
    tokenBudget: input.tokenBudget,
    maxTurns: input.maxTurns,
    checkModel: input.checkModel,
    timeoutMinutes: input.timeoutMinutes,
    systemPromptName: input.systemPromptName,
    workerName: input.workerName,
    status: "queued",
    createdAt: now,
    updatedAt: now,
    cycle: 0,
    progress: []
  };
  await saveGoal(record);
  return record;
}

export async function saveGoal(record: GoalRecord): Promise<GoalRecord> {
  const dir = goalDir(record.id);
  await fs.mkdir(dir, { recursive: true });
  const next = { ...record, updatedAt: new Date().toISOString() };
  const target = goalRecordPath(record.id);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await fs.rename(temporary, target);
  return next;
}

export async function updateGoal(goalId: string, update: (record: GoalRecord) => GoalRecord): Promise<GoalRecord> {
  return saveGoal(update(await loadGoal(goalId)));
}

export async function loadGoal(goalId: string): Promise<GoalRecord> {
  const parsed = JSON.parse(await fs.readFile(goalRecordPath(goalId), "utf8")) as GoalRecord;
  if (parsed.version !== 1 || parsed.id !== safeGoalId(goalId)) throw new Error(`Invalid goal record: ${goalId}`);
  return parsed;
}

export async function listGoals(cwd?: string): Promise<GoalRecord[]> {
  const root = ensureCrewCoderHome().goalsDir;
  const entries = await fs.readdir(root, { withFileTypes: true });
  const resolvedCwd = cwd ? path.resolve(cwd) : undefined;
  const goals: GoalRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const goal = await loadGoal(entry.name);
      if (resolvedCwd && path.resolve(goal.cwd) !== resolvedCwd) continue;
      goals.push(goal);
    } catch {}
  }
  return goals.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function currentGoal(cwd = process.cwd()): Promise<GoalRecord | undefined> {
  const goals = await listGoals(cwd);
  return goals.find((goal) => activeGoalStatus(goal.status)) ?? goals[0];
}

export async function resolveGoal(goalId?: string, cwd = process.cwd()): Promise<GoalRecord> {
  const goal = goalId ? await loadGoal(goalId) : await currentGoal(cwd);
  if (!goal) throw new Error("No goal found in this workspace.");
  return goal;
}

export async function appendGoalEvent(goalId: string, event: unknown): Promise<void> {
  await fs.mkdir(goalDir(goalId), { recursive: true });
  await fs.appendFile(goalEventsPath(goalId), `${JSON.stringify(event)}\n`, "utf8");
}

export function activeGoalStatus(status: GoalStatus): boolean {
  return status === "queued" || status === "running" || status === "awaiting_approval" || status === "paused";
}

function safeGoalId(goalId: string): string {
  const trimmed = goalId.trim();
  if (!/^goal_[A-Za-z0-9_-]+$/.test(trimmed)) throw new Error(`Invalid goal id: ${goalId}`);
  return trimmed;
}

function requiredText(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required.`);
  return trimmed;
}
