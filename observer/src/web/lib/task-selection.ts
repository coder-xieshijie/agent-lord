import type { TaskMeta } from "../../shared/types";

export function selectTask(tasks: TaskMeta[], current: string | null, search: string): string | null {
  const requested = new URLSearchParams(search).get("task");
  if (current && tasks.some((task) => task.taskId === current)) return current;
  // An explicit missing target remains unselected; never silently show another task's output.
  if (requested) return tasks.some((task) => task.taskId === requested) ? requested : null;
  return (tasks.find((task) => task.running) ?? tasks[0])?.taskId ?? null;
}
