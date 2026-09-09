/** Pure helpers for the sidebar's two task-list views:
 *   - "cli": every dispatched CLI execution session, flat, newest first;
 *   - "caller": the same tasks grouped by the scheduling session that
 *     originally launched them (attribution is computed server-side: the
 *     first operation's recorded caller; later follow-ups never move a task).
 *
 * Both views order strictly by last activity, newest first; entries without
 * any recorded activity sink to the end. Ties fall back to task/group ids so
 * polling never reshuffles the list.
 */

import type { TaskMeta } from "../../shared/types";

export type SidebarView = "cli" | "caller";

/** Toggle order as rendered: scheduling sessions before execution sessions. */
export const SIDEBAR_VIEWS: ReadonlyArray<readonly [SidebarView, string]> = [
  ["caller", "调度会话"],
  ["cli", "执行会话"],
];

/** The sidebar opens on the scheduling-session view. */
export const DEFAULT_SIDEBAR_VIEW: SidebarView = "caller";

export const UNATTRIBUTED_GROUP_KEY = "caller:unattributed";

export interface CallerGroup {
  key: string;
  /** Scheduling session id; null for the group of tasks without one. */
  sessionId: string | null;
  /** Name or request preview of the scheduling session; null when unknown. */
  name: string | null;
  /** Basename of the scheduling session's project directory; null when unknown. */
  projectName: string | null;
  /** Newest child activity; null when no child recorded any activity. */
  lastActivityMs: number | null;
  /** Children, newest activity first. */
  tasks: TaskMeta[];
}

function byActivityDesc(a: { lastActivityMs: number | null }, b: { lastActivityMs: number | null }): number {
  const av = a.lastActivityMs ?? Number.NEGATIVE_INFINITY;
  const bv = b.lastActivityMs ?? Number.NEGATIVE_INFINITY;
  if (av !== bv) return av < bv ? 1 : -1;
  return 0;
}

/** Newest activity first; missing timestamps last; deterministic ties. */
export function sortTasksByActivity(tasks: TaskMeta[]): TaskMeta[] {
  return [...tasks].sort((a, b) => byActivityDesc(a, b) || a.taskId.localeCompare(b.taskId));
}

/** Group tasks by their attributed scheduling session. Tasks without one stay
 * reachable in a dedicated trailing-keyed group. Groups sort by their newest
 * child activity; children are newest first. */
export function groupTasksByCaller(tasks: TaskMeta[]): CallerGroup[] {
  const groups = new Map<string, CallerGroup>();
  for (const task of sortTasksByActivity(tasks)) {
    const session = task.caller?.session ?? null;
    const key = session ? `caller:${session.sessionId}` : UNATTRIBUTED_GROUP_KEY;
    let group = groups.get(key);
    if (!group) {
      group = { key, sessionId: session?.sessionId ?? null, name: null, projectName: null, lastActivityMs: null, tasks: [] };
      groups.set(key, group);
    }
    // Children are newest first, so the first task that knows a name/project
    // supplies the freshest metadata; later (older) tasks only fill gaps.
    group.name ??= session?.name ?? null;
    group.projectName ??= session?.projectName ?? null;
    if (task.lastActivityMs !== null && (group.lastActivityMs === null || task.lastActivityMs > group.lastActivityMs))
      group.lastActivityMs = task.lastActivityMs;
    group.tasks.push(task);
  }
  return [...groups.values()].sort((a, b) => byActivityDesc(a, b) || a.key.localeCompare(b.key));
}

/** The group that should open when entering the caller view with a selection. */
export function groupKeyForTask(groups: CallerGroup[], taskId: string | null): string | null {
  if (!taskId) return null;
  return groups.find((group) => group.tasks.some((task) => task.taskId === taskId))?.key ?? null;
}
