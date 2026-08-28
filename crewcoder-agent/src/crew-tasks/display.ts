export function taskStorageKey(task: { id: string; sessionId?: string }): string {
  return task.sessionId ? `${task.sessionId}::${task.id}` : task.id;
}

/** 1-based numbers that restart in every session, independent of project-wide ids. */
export function sessionDisplayNumbers(tasks: Array<{ id: string; sessionId?: string; createdAt?: number }>): Map<string, number> {
  const groups = new Map<string, Array<{ id: string; sessionId?: string; createdAt?: number }>>();
  for (const task of tasks) {
    const scope = task.sessionId ?? "";
    const list = groups.get(scope) ?? [];
    list.push(task);
    groups.set(scope, list);
  }
  const numbers = new Map<string, number>();
  for (const group of groups.values()) {
    const ordered = [...group].sort((left, right) => {
      const created = (left.createdAt ?? 0) - (right.createdAt ?? 0);
      if (created !== 0) return created;
      const leftId = Number(left.id);
      const rightId = Number(right.id);
      if (Number.isFinite(leftId) && Number.isFinite(rightId) && leftId !== rightId) return leftId - rightId;
      return left.id.localeCompare(right.id);
    });
    ordered.forEach((task, index) => numbers.set(taskStorageKey(task), index + 1));
  }
  return numbers;
}

export function formatNumberedTask(
  task: { id: string; sessionId?: string; createdAt?: number; status: string; subject: string; owner?: string; blockedBy?: string[] },
  numbers: Map<string, number>
): string {
  const number = numbers.get(taskStorageKey(task)) ?? Number(task.id);
  const owner = task.owner ? ` owner=${task.owner}` : "";
  const blocked = task.blockedBy?.length ? ` blockedBy=${task.blockedBy.join(",")}` : "";
  return `#${number} [${task.status}] ${task.subject}${owner}${blocked}`;
}
