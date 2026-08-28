import { readCrewTasksConfig } from "./config.js";
import type { CrewTask, CrewTaskStatus } from "./types.js";

/** Claude/CrewCode overlay shape: a full list snapshot, not one mutation. */
export interface CrewTodoSnapshotItem {
  content: string;
  status: CrewTaskStatus;
  activeForm?: string;
}

export function crewTaskTodoSnapshot(tasks: CrewTask[]): CrewTodoSnapshotItem[] {
  return tasks.map((task) => ({
    content: task.subject,
    status: task.status,
    ...(task.activeForm ? { activeForm: task.activeForm } : {})
  }));
}

/**
 * Attach the current session (or listed) todo snapshot when autoSyncTodos is on.
 * Clients such as CrewCode read `details.todos` and ignore sequential display ids.
 */
export function withTodoSnapshot(
  extra: Record<string, unknown> | undefined,
  tasks: CrewTask[]
): Record<string, unknown> {
  const details: Record<string, unknown> = { ...(extra ?? {}) };
  if (readCrewTasksConfig().autoSyncTodos === false) return details;
  details.todos = crewTaskTodoSnapshot(tasks);
  return details;
}
