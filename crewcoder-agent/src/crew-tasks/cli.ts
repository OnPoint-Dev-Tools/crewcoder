import { getCrewTasksConfigPath, readCrewTasksConfig, setCrewTasksEnabled } from "./config.js";
import { formatNumberedTask, sessionDisplayNumbers, taskStorageKey } from "./display.js";
import { getCrewTasksProjectDir, CrewTaskStore } from "./store.js";

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
    const numbers = sessionDisplayNumbers(tasks);
    return tasks.length ? tasks.map((task) => formatNumberedTask(task, numbers)).join("\n") : "No tasks found";
  }
  if (normalized === "add" || normalized === "create") {
    const subject = args.join(" ").trim();
    if (!subject) throw new Error("Usage: crewcoder task add <subject>");
    const task = store.create({ subject, description: subject, metadata: { source: "cli" } });
    const tasks = store.list(readCrewTasksConfig().sortOrder);
    const number = sessionDisplayNumbers(tasks).get(taskStorageKey(task)) ?? task.id;
    return `Created #${number}: ${task.subject}`;
  }
  if (normalized === "done" || normalized === "complete") {
    const id = args[0];
    if (!id) throw new Error("Usage: crewcoder task done <id>");
    const result = store.update(id, { status: "completed" });
    return result.changedFields.length ? `Completed: ${result.task?.subject ?? id}` : `Task not found: ${id}`;
  }
  if (normalized === "start") {
    const id = args[0];
    if (!id) throw new Error("Usage: crewcoder task start <id>");
    const result = store.update(id, { status: "in_progress" });
    return result.changedFields.length ? `In progress: ${result.task?.subject ?? id}` : `Task not found: ${id}`;
  }
  if (normalized === "delete" || normalized === "rm") {
    const id = args[0];
    if (!id) throw new Error("Usage: crewcoder task delete <id>");
    const existing = store.get(id);
    return store.delete(id) ? `Deleted: ${existing?.subject ?? id}` : `Task not found: ${id}`;
  }
  if (normalized === "clear-completed") {
    return `Cleared ${store.clearCompleted()} completed task(s).`;
  }

  throw new Error("Usage: crewcoder task <on|off|status|list|add|start|done|delete|clear-completed>");
}
