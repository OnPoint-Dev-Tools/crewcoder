import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CrewTasksConfig } from "./types.js";

const DEFAULT_CONFIG: CrewTasksConfig = {
  version: 1,
  enabled: false,
  autoSyncTodos: true,
  autoClearCompleted: "on_list_complete",
  defaultProjectStorage: ".crewcoder/tasks",
  sortOrder: "id"
};

export function getCrewTasksConfigPath(): string {
  const root = process.env.CREWCODER_HOME?.trim() || path.join(os.homedir(), ".crewcoder");
  return path.join(path.resolve(root), "tasks", "config.json");
}

export function readCrewTasksConfig(): CrewTasksConfig {
  const configPath = getCrewTasksConfigPath();
  let config = { ...DEFAULT_CONFIG };
  if (fs.existsSync(configPath)) {
    try {
      config = normalizeConfig(JSON.parse(fs.readFileSync(configPath, "utf8")) as Partial<CrewTasksConfig>);
    } catch {
      // Keep defaults for malformed config; the instance override below still applies.
    }
  }
  const instanceOverride = process.env.CREWCODER_TASKS_ENABLED?.trim().toLowerCase();
  if (instanceOverride === "true" || instanceOverride === "1" || instanceOverride === "on") return { ...config, enabled: true };
  if (instanceOverride === "false" || instanceOverride === "0" || instanceOverride === "off") return { ...config, enabled: false };
  return config;
}

export function writeCrewTasksConfig(config: CrewTasksConfig): CrewTasksConfig {
  const normalized = normalizeConfig(config);
  const configPath = getCrewTasksConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(normalized, null, 2) + "\n", "utf8");
  return normalized;
}

export function setCrewTasksEnabled(enabled: boolean): CrewTasksConfig {
  return writeCrewTasksConfig({ ...readCrewTasksConfig(), enabled });
}

function normalizeConfig(input: Partial<CrewTasksConfig>): CrewTasksConfig {
  const autoClear = input.autoClearCompleted;
  const sortOrder = input.sortOrder;
  return {
    version: 1,
    enabled: input.enabled === true,
    autoSyncTodos: input.autoSyncTodos !== false,
    autoClearCompleted: autoClear === "never" || autoClear === "on_task_complete" || autoClear === "on_list_complete" ? autoClear : DEFAULT_CONFIG.autoClearCompleted,
    defaultProjectStorage: ".crewcoder/tasks",
    sortOrder: sortOrder === "status" || sortOrder === "recent" || sortOrder === "oldest" || sortOrder === "id" ? sortOrder : DEFAULT_CONFIG.sortOrder
  };
}
