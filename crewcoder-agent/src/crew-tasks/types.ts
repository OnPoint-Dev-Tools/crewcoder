export type CrewTaskStatus = "pending" | "in_progress" | "completed";

export type CrewTaskSortOrder = "id" | "status" | "recent" | "oldest";

export interface CrewTask {
  id: string;
  subject: string;
  description: string;
  status: CrewTaskStatus;
  activeForm?: string;
  owner?: string;
  sessionId?: string;
  projectPath: string;
  metadata: Record<string, unknown>;
  blocks: string[];
  blockedBy: string[];
  createdAt: number;
  updatedAt: number;
}

export interface CrewTaskStoreData {
  version: 1;
  nextId: number;
  tasks: CrewTask[];
}

export interface CrewTaskSessionRecord {
  sessionId: string;
  projectPath: string;
  taskIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface CrewTaskSessionsData {
  version: 1;
  sessions: CrewTaskSessionRecord[];
}

export interface CrewTasksConfig {
  version: 1;
  enabled: boolean;
  autoSyncTodos: boolean;
  autoClearCompleted: "never" | "on_list_complete" | "on_task_complete";
  defaultProjectStorage: ".crewcoder/tasks";
  sortOrder: CrewTaskSortOrder;
}
