import fs from "node:fs";
import path from "node:path";
import type { CrewTask, CrewTaskSessionRecord, CrewTaskSessionsData, CrewTaskSortOrder, CrewTaskStatus, CrewTaskStoreData } from "./types.js";

const LOCK_RETRY_MS = 25;
const LOCK_MAX_RETRIES = 120;

function busyWait(ms: number): void {
  const start = Date.now();
  while (Date.now() - start < ms) { /* wait */ }
}

function isProcessRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function acquireLock(lockPath: string): void {
  for (let i = 0; i < LOCK_MAX_RETRIES; i++) {
    try {
      fs.writeFileSync(lockPath, `${process.pid}`, { flag: "wx" });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const pid = Number(fs.readFileSync(lockPath, "utf8"));
        if (pid && !isProcessRunning(pid)) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch { /* ignore stale lock read failures */ }
      busyWait(LOCK_RETRY_MS);
    }
  }
  throw new Error(`Failed to acquire task store lock: ${lockPath}`);
}

function releaseLock(lockPath: string): void {
  try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
}

const sorters: Record<CrewTaskSortOrder, (a: CrewTask, b: CrewTask) => number> = {
  id: (a, b) => Number(a.id) - Number(b.id),
  status: (a, b) => ({ completed: 2, in_progress: 1, pending: 0 }[a.status] - { completed: 2, in_progress: 1, pending: 0 }[b.status]) || Number(a.id) - Number(b.id),
  recent: (a, b) => b.updatedAt - a.updatedAt || Number(b.id) - Number(a.id),
  oldest: (a, b) => a.updatedAt - b.updatedAt || Number(a.id) - Number(b.id)
};

export function getCrewTasksProjectDir(cwd: string): string {
  return path.join(path.resolve(cwd), ".crewcoder", "tasks");
}

export class CrewTaskStore {
  private readonly filePath: string;
  private readonly lockPath: string;
  private nextId = 1;
  private tasks = new Map<string, CrewTask>();

  constructor(private readonly cwd: string) {
    this.filePath = path.join(getCrewTasksProjectDir(cwd), "tasks.json");
    this.lockPath = `${this.filePath}.lock`;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.load();
  }

  get path(): string { return this.filePath; }

  create(input: { subject: string; description: string; activeForm?: string; owner?: string; sessionId?: string; metadata?: Record<string, unknown> }): CrewTask {
    return this.withLock(() => {
      if (input.sessionId) this.retireCompletedSession(input.sessionId);
      const now = Date.now();
      const task: CrewTask = {
        id: this.nextIdInScope(input.sessionId),
        subject: input.subject,
        description: input.description,
        status: "pending",
        activeForm: input.activeForm,
        owner: input.owner,
        sessionId: input.sessionId,
        projectPath: path.resolve(this.cwd),
        metadata: input.metadata ?? {},
        blocks: [],
        blockedBy: [],
        createdAt: now,
        updatedAt: now
      };
      this.tasks.set(this.storageKey(task), task);
      if (task.sessionId) this.addTaskToSession(task.sessionId, task.id, now);
      return task;
    });
  }

  get(id: string, sessionId?: string): CrewTask | undefined {
    this.load();
    return this.lookup(id, sessionId);
  }

  list(sortOrder: CrewTaskSortOrder = "id", filter?: { sessionId?: string; includeCompleted?: boolean }): CrewTask[] {
    this.load();
    return [...this.tasks.values()]
      .filter((task) => !filter?.sessionId || task.sessionId === filter.sessionId)
      .filter((task) => filter?.includeCompleted !== false || task.status !== "completed")
      .sort(sorters[sortOrder]);
  }

  update(id: string, fields: {
    status?: CrewTaskStatus | "deleted";
    subject?: string;
    description?: string;
    activeForm?: string;
    owner?: string;
    sessionId?: string;
    metadata?: Record<string, unknown>;
    addBlocks?: string[];
    addBlockedBy?: string[];
  }, sessionId?: string): { task: CrewTask | undefined; changedFields: string[]; warnings: string[] } {
    return this.withLock(() => {
      const task = this.lookup(id, sessionId);
      if (!task) return { task: undefined, changedFields: [], warnings: [] };
      const changedFields: string[] = [];
      const warnings: string[] = [];
      const scope = sessionId ?? task.sessionId;
      const oldKey = this.storageKey(task);

      if (fields.status === "deleted") {
        this.tasks.delete(oldKey);
        this.removeDependencyEdges(task.id, scope);
        return { task: undefined, changedFields: ["deleted"], warnings };
      }
      if (fields.status !== undefined) { task.status = fields.status; changedFields.push("status"); }
      if (fields.subject !== undefined) { task.subject = fields.subject; changedFields.push("subject"); }
      if (fields.description !== undefined) { task.description = fields.description; changedFields.push("description"); }
      if (fields.activeForm !== undefined) { task.activeForm = fields.activeForm; changedFields.push("activeForm"); }
      if (fields.owner !== undefined) { task.owner = fields.owner; changedFields.push("owner"); }
      if (fields.sessionId !== undefined) {
        task.sessionId = fields.sessionId;
        this.addTaskToSession(fields.sessionId, task.id, Date.now());
        changedFields.push("sessionId");
      }
      if (fields.metadata !== undefined) {
        for (const [key, value] of Object.entries(fields.metadata)) {
          if (value === null) delete task.metadata[key];
          else task.metadata[key] = value;
        }
        changedFields.push("metadata");
      }
      if (fields.addBlocks?.length) {
        for (const targetId of fields.addBlocks) this.addEdge(task.id, targetId, warnings, scope);
        changedFields.push("blocks");
      }
      if (fields.addBlockedBy?.length) {
        for (const sourceId of fields.addBlockedBy) this.addEdge(sourceId, task.id, warnings, scope);
        changedFields.push("blockedBy");
      }
      const newKey = this.storageKey(task);
      if (oldKey !== newKey) {
        this.tasks.delete(oldKey);
        this.tasks.set(newKey, task);
      }
      if (changedFields.length) task.updatedAt = Date.now();
      return { task, changedFields: [...new Set(changedFields)], warnings };
    });
  }

  delete(id: string, sessionId?: string): boolean {
    return this.withLock(() => {
      const task = this.lookup(id, sessionId);
      if (!task) return false;
      this.tasks.delete(this.storageKey(task));
      this.removeDependencyEdges(task.id, sessionId ?? task.sessionId);
      return true;
    });
  }

  clearCompleted(): number {
    return this.withLock(() => {
      const completed = [...this.tasks.values()].filter((task) => task.status === "completed");
      for (const task of completed) this.tasks.delete(this.storageKey(task));
      for (const task of completed) this.removeDependencyEdges(task.id, task.sessionId);
      return completed.length;
    });
  }

  clearAll(): number {
    return this.withLock(() => {
      const count = this.tasks.size;
      this.tasks.clear();
      return count;
    });
  }

  private storageKey(task: { id: string; sessionId?: string }): string {
    return task.sessionId ? `${task.sessionId}::${task.id}` : task.id;
  }

  private lookup(id: string, sessionId?: string): CrewTask | undefined {
    if (sessionId) {
      const scoped = this.tasks.get(`${sessionId}::${id}`);
      if (scoped) return scoped;
    }
    const exact = this.tasks.get(id);
    if (exact) return exact;
    const matches = [...this.tasks.values()].filter((task) => task.id === id);
    if (sessionId) return matches.find((task) => task.sessionId === sessionId);
    return matches.length === 1 ? matches[0] : undefined;
  }

  private peers(sessionId?: string): CrewTask[] {
    const scope = sessionId ?? "";
    return [...this.tasks.values()].filter((task) => (task.sessionId ?? "") === scope);
  }

  private nextIdInScope(sessionId?: string): string {
    const max = Math.max(0, ...this.peers(sessionId).map((task) => Number(task.id)).filter((id) => Number.isFinite(id) && id > 0));
    return String(max + 1);
  }

  private retireCompletedSession(sessionId: string): void {
    const peers = this.peers(sessionId);
    if (peers.length === 0 || peers.some((task) => task.status !== "completed")) return;
    for (const task of peers) {
      this.tasks.delete(this.storageKey(task));
      this.removeDependencyEdges(task.id, sessionId);
    }
  }

  private addEdge(sourceId: string, targetId: string, warnings: string[], sessionId?: string): void {
    const source = this.lookup(sourceId, sessionId);
    const target = this.lookup(targetId, sessionId);
    if (!source) { warnings.push(`task ${sourceId} does not exist`); return; }
    if (!target) warnings.push(`task ${targetId} does not exist`);
    if (sourceId === targetId) warnings.push(`task ${sourceId} blocks itself`);
    if (!source.blocks.includes(targetId)) source.blocks.push(targetId);
    if (target && !target.blockedBy.includes(sourceId)) target.blockedBy.push(sourceId);
    if (target?.blocks.includes(sourceId)) warnings.push(`cycle: ${sourceId} and ${targetId} block each other`);
  }

  private removeDependencyEdges(id: string, sessionId?: string): void {
    for (const task of this.tasks.values()) {
      if (sessionId && task.sessionId !== sessionId) continue;
      if (!sessionId && task.sessionId) continue;
      task.blocks = task.blocks.filter((taskId) => taskId !== id);
      task.blockedBy = task.blockedBy.filter((taskId) => taskId !== id);
    }
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<CrewTaskStoreData>;
      this.nextId = typeof data.nextId === "number" && data.nextId > 0 ? data.nextId : 1;
      this.tasks = new Map();
      for (const task of data.tasks ?? []) this.tasks.set(this.storageKey(task), task);
    } catch { /* corrupt project task file: keep current in-memory state */ }
  }

  private save(): void {
    const data: CrewTaskStoreData = { version: 1, nextId: this.nextId, tasks: [...this.tasks.values()] };
    const tmpPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf8");
    fs.renameSync(tmpPath, this.filePath);
  }

  private withLock<T>(fn: () => T): T {
    acquireLock(this.lockPath);
    try {
      this.load();
      const result = fn();
      this.save();
      return result;
    } finally {
      releaseLock(this.lockPath);
    }
  }

  private addTaskToSession(sessionId: string, taskId: string, now: number): void {
    const sessionsPath = path.join(getCrewTasksProjectDir(this.cwd), "sessions.json");
    let data: CrewTaskSessionsData = { version: 1, sessions: [] };
    try {
      if (fs.existsSync(sessionsPath)) data = JSON.parse(fs.readFileSync(sessionsPath, "utf8")) as CrewTaskSessionsData;
    } catch { /* start fresh */ }
    const record = data.sessions.find((item) => item.sessionId === sessionId) ?? { sessionId, projectPath: path.resolve(this.cwd), taskIds: [], createdAt: now, updatedAt: now } satisfies CrewTaskSessionRecord;
    if (!data.sessions.includes(record)) data.sessions.push(record);
    if (!record.taskIds.includes(taskId)) record.taskIds.push(taskId);
    record.updatedAt = now;
    fs.writeFileSync(sessionsPath, JSON.stringify(data, null, 2) + "\n", "utf8");
  }
}
