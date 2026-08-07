import { getCrewTasksConfigPath, readCrewTasksConfig, setCrewTasksEnabled } from "./config.js";
import { getCrewTasksProjectDir, CrewTaskStore } from "./store.js";
import type { CrewTask } from "./types.js";

function ensureEnabled(command: string): void {
  if (!readCrewTasksConfig().enabled) throw new Error(`crew-tasks is disabled. Run \`crewcoder task on\` or /task on before \`${command}\`.`);
}

export function runCrewTaskCommand(action: string | undefined, args: string[], cwd = process.cwd()): string {
  const normalized = (action ?? "status").toLowerCase();
  if (normalized === "on" || normalized === "enable") {
    const cfg = setCrewTasksEnabled(true);
    return [`crew-tasks enabled.`, `config: ${getCrewTasksConfigPath()}`, `project store: ${getCrewTasksProjectDir(cwd)}`, `autoSyncTodos: ${cfg.autoSyncTodos}`].join("\n");
  }
  if (normalized === "off" || normalized === "disable") {
    setCrewTasksEnabled(false);
    return [`crew-tasks disabled.`, `config: ${getCrewTasksConfigPath()}`, `Project task data was not deleted.`].join("\n");
  }
  if (normalized === "status") {
    const cfg = readCrewTasksConfig();
    return [`crew-tasks: ${cfg.enabled ? "on" : "off"}`, `config: ${getCrewTasksConfigPath()}`, `project store: ${getCrewTasksProjectDir(cwd)}`, `autoSyncTodos: ${cfg.autoSyncTodos}`].join("\n");
  }

  ensureEnabled(`task ${normalized}`);
  const store = new CrewTaskStore(cwd);

  if (normalized === "list" || normalized === "ls") {
    const tasks = store.list(readCrewTasksConfig().sortOrder);
    return tasks.length ? tasks.map(formatTask).join("\n") : "No tasks found";
  }
  if (normalized === "add" || normalized === "create") {
    const subject = args.join(" ").trim();
    if (!subject) throw new Error("Usage: crewcoder task add <subject>");
    const task = store.create({ subject, description: subject, metadata: { source: "cli" } });
    return `Task #${task.id} created: ${task.subject}`;
  }
  if (normalized === "done" || normalized === "complete") {
    const id = args[0];
    if (!id) throw new Error("Usage: crewcoder task done <id>");
    const result = store.update(id, { status: "completed" });
    return result.changedFields.length ? `Task #${id} completed` : `Task #${id} not found`;
  }
  if (normalized === "start") {
    const id = args[0];
    if (!id) throw new Error("Usage: crewcoder task start <id>");
    const result = store.update(id, { status: "in_progress" });
    return result.changedFields.length ? `Task #${id} in progress` : `Task #${id} not found`;
  }
  if (normalized === "delete" || normalized === "rm") {
    const id = args[0];
    if (!id) throw new Error("Usage: crewcoder task delete <id>");
    return store.delete(id) ? `Task #${id} deleted` : `Task #${id} not found`;
  }
  if (normalized === "clear-completed") {
    return `Cleared ${store.clearCompleted()} completed task(s).`;
  }

  throw new Error("Usage: crewcoder task <on|off|status|list|add|start|done|delete|clear-completed>");
}

function formatTask(task: CrewTask): string {
  const session = task.sessionId ? ` session=${task.sessionId}` : "";
  return `#${task.id} [${task.status}] ${task.subject}${session}`;
}
