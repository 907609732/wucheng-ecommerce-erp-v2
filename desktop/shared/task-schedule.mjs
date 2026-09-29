const PRIORITY = Object.freeze({ sync: 0, "monthly-sales": 1 });

export function mergeScheduledTasks(existing = [], incoming = []) {
  const tasks = [];
  const keys = new Set();
  for (const task of [...existing, ...incoming]) {
    const key = task.key || `${task.kind}:${JSON.stringify(task.options || {})}`;
    if (keys.has(key)) continue;
    keys.add(key);
    tasks.push({ ...task, key });
  }
  return tasks.sort((a, b) => (PRIORITY[a.kind] ?? 9) - (PRIORITY[b.kind] ?? 9));
}

export function queueAfterTaskResult(queue, { success, cancelled } = {}) {
  return success && !cancelled ? queue : [];
}
