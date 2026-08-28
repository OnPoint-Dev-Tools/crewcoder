import type { ToolDefinition } from "../core/tool-types.js";
import { textResult } from "../core/tool-types.js";
import { readCrewTasksConfig } from "./config.js";
import { formatNumberedTask, sessionDisplayNumbers, taskStorageKey } from "./display.js";
import { withTodoSnapshot } from "./snapshot.js";
import { CrewTaskStore } from "./store.js";
import type { CrewTask, CrewTaskStatus } from "./types.js";

function assertEnabled(): void {
  if (!readCrewTasksConfig().enabled) throw new Error("crew-tasks is disabled. Run /task on or `crewcoder task on` first.");
}

function sessionTasks(store: CrewTaskStore, sessionId?: string): CrewTask[] {
  return store.list("id", { sessionId, includeCompleted: true });
}

function displayNumber(task: CrewTask, tasks: CrewTask[]): number {
  return sessionDisplayNumbers(tasks).get(taskStorageKey(task)) ?? Number(task.id);
}

export const TaskCreateTool: ToolDefinition<{ subject: string; description: string; activeForm?: string; owner?: string; metadata?: Record<string, unknown> }> = {
  name: "TaskCreate",
  description: "Create a persistent crew-tasks task in the current project's .crewcoder/tasks store. Use for complex multi-step work, project/session-aware tracking, and agent todo integration. Mark tasks in_progress before starting and completed after finishing.",
  parameters: {
    type: "object",
    properties: {
      subject: { type: "string", description: "Brief actionable task title." },
      description: { type: "string", description: "Detailed requirements and acceptance criteria." },
      activeForm: { type: "string", description: "Present-continuous form for UI/status displays." },
      owner: { type: "string", description: "Optional worker/agent owner." },
      metadata: { type: "object", description: "Arbitrary JSON metadata for integration state.", additionalProperties: true }
    },
    required: ["subject", "description"],
    additionalProperties: false
  },
  parse(args) {
    return {
      subject: String(args.subject ?? "").trim(),
      description: String(args.description ?? "").trim(),
      activeForm: typeof args.activeForm === "string" ? args.activeForm : undefined,
      owner: typeof args.owner === "string" ? args.owner : undefined,
      metadata: typeof args.metadata === "object" && args.metadata !== null ? args.metadata as Record<string, unknown> : undefined
    };
  },
  async execute(args, context) {
    assertEnabled();
    if (!args.subject) throw new Error("subject is required");
    if (!args.description) throw new Error("description is required");
    const store = new CrewTaskStore(context.cwd);
    const task = store.create({ ...args, sessionId: context.sessionId, metadata: { ...(args.metadata ?? {}), source: "agent" } });
    const tasks = sessionTasks(store, context.sessionId);
    return textResult(`Created #${displayNumber(task, tasks)}: ${task.subject}`, withTodoSnapshot({ task }, tasks));
  }
};

export const TaskListTool: ToolDefinition<{ sort?: "id" | "status" | "recent" | "oldest"; sessionOnly: boolean; includeCompleted: boolean }> = {
  name: "TaskList",
  description: "List persistent crew-tasks tasks for the current project, optionally scoped to this session.",
  parameters: {
    type: "object",
    properties: {
      sort: { type: "string", enum: ["id", "status", "recent", "oldest"], description: "Sort order." },
      sessionOnly: { type: "boolean", description: "Only show tasks attached to the current session." },
      includeCompleted: { type: "boolean", description: "Include completed tasks." }
    },
    additionalProperties: false
  },
  parse(args) {
    const sort = ["id", "status", "recent", "oldest"].includes(String(args.sort)) ? args.sort as "id" | "status" | "recent" | "oldest" : undefined;
    return { sort, sessionOnly: args.sessionOnly === true, includeCompleted: args.includeCompleted !== false };
  },
  async execute(args, context) {
    assertEnabled();
    const cfg = readCrewTasksConfig();
    const store = new CrewTaskStore(context.cwd);
    const tasks = store.list(args.sort ?? cfg.sortOrder, { sessionId: args.sessionOnly ? context.sessionId : undefined, includeCompleted: args.includeCompleted });
    const numbers = sessionDisplayNumbers(tasks);
    return textResult(tasks.length ? tasks.map((task) => formatNumberedTask(task, numbers)).join("\n") : "No tasks found", withTodoSnapshot({ count: tasks.length }, tasks));
  }
};

export const TaskGetTool: ToolDefinition<{ taskId: string }> = {
  name: "TaskGet",
  description: "Get full details for a crew-tasks task by id.",
  parameters: { type: "object", properties: { taskId: { type: "string", description: "Task id." } }, required: ["taskId"], additionalProperties: false },
  parse(args) { return { taskId: String(args.taskId ?? "").trim() }; },
  async execute(args, context) {
    assertEnabled();
    const store = new CrewTaskStore(context.cwd);
    const task = store.get(args.taskId, context.sessionId);
    if (!task) return textResult(`Task not found: ${args.taskId}`);
    const tasks = sessionTasks(store, task.sessionId ?? context.sessionId);
    const lines = [
      `Task #${displayNumber(task, tasks)}: ${task.subject}`,
      `taskId: ${task.id}`,
      `Status: ${task.status}`,
      task.sessionId ? `Session: ${task.sessionId}` : undefined,
      task.owner ? `Owner: ${task.owner}` : undefined,
      `Description: ${task.description.replace(/\\n/g, "\n")}`,
      task.blockedBy.length ? `Blocked by: ${task.blockedBy.join(", ")}` : undefined,
      task.blocks.length ? `Blocks: ${task.blocks.join(", ")}` : undefined,
      Object.keys(task.metadata).length ? `Metadata: ${JSON.stringify(task.metadata)}` : undefined
    ].filter(Boolean) as string[];
    return textResult(lines.join("\n"), withTodoSnapshot({ task }, tasks));
  }
};

export const TaskUpdateTool: ToolDefinition<{ taskId: string; status?: CrewTaskStatus | "deleted"; subject?: string; description?: string; activeForm?: string; owner?: string; metadata?: Record<string, unknown>; addBlocks?: string[]; addBlockedBy?: string[] }> = {
  name: "TaskUpdate",
  description: "Update a crew-tasks task. Use status pending, in_progress, completed, or deleted. Supports ownership, metadata, and dependency edges.",
  parameters: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "Task id." },
      status: { type: "string", enum: ["pending", "in_progress", "completed", "deleted"], description: "New status." },
      subject: { type: "string", description: "New subject." },
      description: { type: "string", description: "New description." },
      activeForm: { type: "string", description: "Present-continuous UI text." },
      owner: { type: "string", description: "Task owner." },
      metadata: { type: "object", description: "Metadata merge; null values delete keys.", additionalProperties: true },
      addBlocks: { type: "array", items: { type: "string" }, description: "Task ids this task blocks." },
      addBlockedBy: { type: "array", items: { type: "string" }, description: "Task ids that block this task." }
    },
    required: ["taskId"],
    additionalProperties: false
  },
  parse(args) {
    const status = ["pending", "in_progress", "completed", "deleted"].includes(String(args.status)) ? args.status as CrewTaskStatus | "deleted" : undefined;
    return {
      taskId: String(args.taskId ?? "").trim(),
      status,
      subject: typeof args.subject === "string" ? args.subject : undefined,
      description: typeof args.description === "string" ? args.description : undefined,
      activeForm: typeof args.activeForm === "string" ? args.activeForm : undefined,
      owner: typeof args.owner === "string" ? args.owner : undefined,
      metadata: typeof args.metadata === "object" && args.metadata !== null ? args.metadata as Record<string, unknown> : undefined,
      addBlocks: Array.isArray(args.addBlocks) ? args.addBlocks.map(String) : undefined,
      addBlockedBy: Array.isArray(args.addBlockedBy) ? args.addBlockedBy.map(String) : undefined
    };
  },
  async execute(args, context) {
    assertEnabled();
    const { taskId, ...fields } = args;
    const store = new CrewTaskStore(context.cwd);
    const result = store.update(taskId, fields, context.sessionId);
    if (!result.task && !result.changedFields.length) return textResult(`Task not found: ${taskId}`);
    const warnings = result.warnings.length ? ` (warning: ${result.warnings.join("; ")})` : "";
    const sessionId = result.task?.sessionId ?? context.sessionId;
    const tasks = sessionTasks(store, sessionId);
    const label = result.task ? `#${displayNumber(result.task, tasks)}: ${result.task.subject}` : taskId;
    return textResult(`Updated ${label} (${result.changedFields.join(", ")})${warnings}`, withTodoSnapshot(result, tasks));
  }
};

export const TaskDeleteTool: ToolDefinition<{ taskId: string }> = {
  name: "TaskDelete",
  description: "Delete a crew-tasks task by id.",
  parameters: { type: "object", properties: { taskId: { type: "string", description: "Task id." } }, required: ["taskId"], additionalProperties: false },
  parse(args) { return { taskId: String(args.taskId ?? "").trim() }; },
  async execute(args, context) {
    assertEnabled();
    const store = new CrewTaskStore(context.cwd);
    const existing = store.get(args.taskId, context.sessionId);
    const sessionId = existing?.sessionId ?? context.sessionId;
    const tasks = sessionTasks(store, sessionId);
    const label = existing ? `#${displayNumber(existing, tasks)}: ${existing.subject}` : args.taskId;
    const deleted = store.delete(args.taskId, context.sessionId);
    return textResult(deleted ? `Deleted ${label}` : `Task not found: ${args.taskId}`, withTodoSnapshot({ deleted }, sessionTasks(store, sessionId)));
  }
};

export function createCrewTaskTools(): ToolDefinition[] {
  if (!readCrewTasksConfig().enabled) return [];
  return [TaskCreateTool, TaskListTool, TaskGetTool, TaskUpdateTool, TaskDeleteTool];
}
