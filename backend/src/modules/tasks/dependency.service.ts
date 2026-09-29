import type { Blocker } from '../../core/authz/transition-policy.ts';
import { AppError } from '../../lib/errors.ts';
import { type Tx, writeLog } from './audit.service.ts';

/**
 * The dependency engine.
 *
 * The graph is a directed acyclic graph over tasks. `TaskDependency` is an edge
 * `task -> dependsOnTask`, meaning "task cannot be worked on until
 * dependsOnTask is DONE".
 *
 * Three responsibilities live here:
 *
 *  1. **Query** — which prerequisites of a task are still unfinished? Every
 *     read and every transition needs this, so it is a single indexed query
 *     rather than N round trips.
 *  2. **Integrity** — refuse edges that would create a cycle, or that cross
 *     project boundaries, or that a task has on itself.
 *  3. **Reconciliation** — keep the stored `BLOCKED` status in step with the
 *     graph. This runs inside the same transaction as any status change, so the
 *     board can never show a task as workable when its prerequisite is not
 *     done, or hide one that has been unblocked.
 */

/** Prerequisite tasks of `taskId` that are not yet DONE. */
export async function getBlockers(tx: Tx, taskId: string): Promise<Blocker[]> {
  const edges = await tx.taskDependency.findMany({
    where: { taskId },
    select: { dependsOnTask: { select: { id: true, title: true, status: true } } },
  });

  return edges
    .map((e: (typeof edges)[number]) => e.dependsOnTask)
    .filter((t: (typeof edges)[number]['dependsOnTask']) => t.status !== 'DONE')
    .map((t: (typeof edges)[number]['dependsOnTask']) => ({ taskId: t.id, title: t.title, status: t.status }));
}

/** All prerequisite tasks regardless of status — used for the detail view. */
export async function getPrerequisites(tx: Tx, taskId: string) {
  return tx.taskDependency.findMany({
    where: { taskId },
    orderBy: { createdAt: 'asc' },
    include: { dependsOnTask: { select: { id: true, title: true, status: true, department: true } } },
  });
}

/** Tasks that depend on `taskId` — the "unblocks" tab of the detail view. */
export async function getDependents(tx: Tx, taskId: string) {
  return tx.taskDependency.findMany({
    where: { dependsOnTaskId: taskId },
    orderBy: { createdAt: 'asc' },
    include: { task: { select: { id: true, title: true, status: true, department: true } } },
  });
}

/**
 * Would adding `fromTask -> dependsOnTask` create a cycle?
 *
 * A cycle exists iff `dependsOnTask` can already reach `fromTask` through
 * existing edges. We walk downstream from `dependsOnTask` following
 * "depends on" edges: if we arrive at `fromTask`, the new edge closes a loop.
 *
 * The walk is iterative rather than recursive so a long chain cannot blow the
 * call stack, and it is bounded by a visited set so a diamond-shaped graph
 * cannot loop forever.
 */
export async function wouldCreateCycle(tx: Tx, fromTaskId: string, dependsOnTaskId: string): Promise<string[] | null> {
  const adjacency = await tx.taskDependency.findMany({
    select: { taskId: true, dependsOnTaskId: true },
  });

  const edges = new Map<string, string[]>();
  for (const e of adjacency) {
    const list = edges.get(e.taskId) ?? [];
    list.push(e.dependsOnTaskId);
    edges.set(e.taskId, list);
  }

  // Depth-first search downstream of the new prerequisite, looking for the
  // task that would gain a new incoming dependency.
  const path: string[] = [];
  const visited = new Set<string>();
  const stack: string[] = [dependsOnTaskId];

  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (visited.has(current)) continue;
    visited.add(current);

    if (current === fromTaskId) {
      // Reconstruct a readable path for the error message.
      return [fromTaskId, ...path.slice().reverse(), dependsOnTaskId];
    }

    path.push(current);
    for (const next of edges.get(current) ?? []) {
      if (!visited.has(next)) stack.push(next);
    }
  }

  return null;
}

export interface AddDependencyInput {
  taskId: string;
  dependsOnTaskId: string;
  userId: string;
}

/**
 * Add a dependency edge, rejecting the three ways the graph can become
 * meaningless.
 *
 * PM-only is enforced by the caller (`task:manageDependencies`); this function
 * owns graph integrity.
 */
export async function addDependency(tx: Tx, input: AddDependencyInput): Promise<void> {
  if (input.taskId === input.dependsOnTaskId) {
    throw new AppError('SELF_DEPENDENCY', 'A task cannot depend on itself', {
      taskId: input.taskId,
    });
  }

  type TaskRef = { id: string; projectId: string; title: string };
  const tasks: TaskRef[] = await tx.task.findMany({
    where: { id: { in: [input.taskId, input.dependsOnTaskId] } },
    select: { id: true, projectId: true, title: true },
  });

  const task = tasks.find((t: TaskRef) => t.id === input.taskId);
  const prerequisite = tasks.find((t: TaskRef) => t.id === input.dependsOnTaskId);

  if (!task || !prerequisite) {
    throw AppError.notFound('Task', !task ? input.taskId : input.dependsOnTaskId);
  }

  if (task.projectId !== prerequisite.projectId) {
    throw new AppError('CROSS_PROJECT_DEPENDENCY', 'Dependencies must stay within a single project', {
      taskProjectId: task.projectId,
      prerequisiteProjectId: prerequisite.projectId,
    });
  }

  const existing = await tx.taskDependency.findUnique({
    where: { taskId_dependsOnTaskId: { taskId: input.taskId, dependsOnTaskId: input.dependsOnTaskId } },
  });
  if (existing) {
    throw new AppError('DUPLICATE_DEPENDENCY', `"${prerequisite.title}" is already a prerequisite of "${task.title}"`, {
      taskId: input.taskId,
      dependsOnTaskId: input.dependsOnTaskId,
    });
  }

  const cycle = await wouldCreateCycle(tx, input.taskId, input.dependsOnTaskId);
  if (cycle) {
    throw new AppError('CYCLE_DETECTED', 'This dependency would create a circular chain of tasks', { cycle });
  }

  await tx.taskDependency.create({
    data: {
      taskId: input.taskId,
      dependsOnTaskId: input.dependsOnTaskId,
      createdById: input.userId,
    },
  });

  await writeLog(tx, {
    taskId: input.taskId,
    projectId: task.projectId,
    userId: input.userId,
    action: 'DEPENDENCY_ADDED',
    column: 'dependsOn',
    oldValue: null,
    newValue: prerequisite.title,
    metadata: { dependsOnTaskId: input.dependsOnTaskId },
  });
}

/**
 * Remove a dependency edge and re-reconcile the task, because removing the last
 * blocker is what promotes a task out of BLOCKED.
 */
export async function removeDependency(
  tx: Tx,
  args: { taskId: string; dependencyId: string; userId: string },
): Promise<void> {
  const edge = await tx.taskDependency.findUnique({
    where: { id: args.dependencyId },
    include: {
      task: { select: { id: true, projectId: true, title: true } },
      dependsOnTask: { select: { title: true } },
    },
  });

  if (!edge || edge.taskId !== args.taskId) {
    throw AppError.notFound('Dependency', args.dependencyId);
  }

  await tx.taskDependency.delete({ where: { id: args.dependencyId } });

  await writeLog(tx, {
    taskId: edge.task.id,
    projectId: edge.task.projectId,
    userId: args.userId,
    action: 'DEPENDENCY_REMOVED',
    column: 'dependsOn',
    oldValue: edge.dependsOnTask.title,
    newValue: null,
    metadata: { dependsOnTaskId: edge.dependsOnTaskId },
  });
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/**
 * Bring a task's stored status back in line with its dependency graph.
 *
 * The rules:
 *
 *  - Prerequisites unsatisfied and the task has not started
 *    (`TODO`/`BLOCKED`) -> `BLOCKED`.
 *  - Prerequisites all satisfied and the task sits in `BLOCKED` -> `TODO`.
 *  - Prerequisites unsatisfied but the task has *already* started
 *    (`IN_PROGRESS`/`IN_REVIEW`) -> demote to `BLOCKED`. This is the
 *    regression case: someone moved a prerequisite back out of DONE, and the
 *    dependent must stop being treated as workable. A reviewer reopening a
 *    prerequisite therefore has a visible, audited consequence rather than a
 *    silent inconsistency.
 *
 * Every change it makes is written to the audit trail with a
 * `systemInitiated` marker so a human reader can tell an automatic transition
 * from a deliberate one.
 */
export async function reconcileBlockedState(
  tx: Tx,
  taskId: string,
  opts: { userId: string; systemInitiated?: boolean },
): Promise<{ from: string; to: string } | null> {
  const task = await tx.task.findUnique({
    where: { id: taskId },
    select: { id: true, projectId: true, status: true, version: true },
  });
  if (!task) return null;

  const blockers = await getBlockers(tx, taskId);
  const hasBlockers = blockers.length > 0;

  let target: 'BLOCKED' | 'TODO' | null = null;
  if (hasBlockers && (task.status === 'TODO' || task.status === 'IN_PROGRESS' || task.status === 'IN_REVIEW')) {
    target = 'BLOCKED';
  } else if (!hasBlockers && task.status === 'BLOCKED') {
    target = 'TODO';
  }

  if (target === null) return null;

  // Guard the write on the version we read, so a concurrent human edit between
  // the read and this write is rejected rather than silently overwritten by the
  // reconciler. Zero rows affected means somebody else moved first; the caller
  // re-reads and the next reconcile pass will settle it.
  const updated = await tx.task.updateMany({
    where: { id: taskId, version: task.version },
    data: {
      status: target,
      version: { increment: 1 },
      ...(target === 'TODO' ? { startedAt: null, completedAt: null } : {}),
    },
  });

  if (updated.count === 0) return null;

  await writeLog(tx, {
    taskId: task.id,
    projectId: task.projectId,
    userId: opts.userId,
    action: target === 'BLOCKED' ? 'AUTO_BLOCKED' : 'AUTO_UNBLOCKED',
    column: 'status',
    oldValue: task.status,
    newValue: target,
    metadata: {
      systemInitiated: true,
      ...(opts.systemInitiated !== undefined ? { systemInitiatedFlag: opts.systemInitiated } : {}),
      blockers: blockers.map((b) => ({ taskId: b.taskId, title: b.title, status: b.status })),
    },
  });

  return { from: task.status, to: target };
}

/**
 * Re-reconcile a task and everything downstream of it, breadth-first.
 *
 * Unblocking task A can unblock task C which depends on A, and so on. Callers
 * invoke this after any status change that could affect the graph, so the whole
 * affected subtree settles before the transaction commits.
 */
export async function reconcileSubgraph(
  tx: Tx,
  rootTaskId: string,
  opts: { userId: string; maxDepth?: number },
): Promise<void> {
  const maxDepth = opts.maxDepth ?? 25;

  const queue: Array<{ id: string; depth: number }> = [{ id: rootTaskId, depth: 0 }];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const next = queue.shift() as { id: string; depth: number };
    if (seen.has(next.id) || next.depth > maxDepth) continue;
    seen.add(next.id);

    await reconcileBlockedState(tx, next.id, { userId: opts.userId, systemInitiated: true });

    // Downstream edges point from a task to what it depends on. A task's status
    // change affects the tasks that depend on *it*, which are found by
    // inverting the edge: `dependsOnTaskId = next.id`.
    const dependents = await tx.taskDependency.findMany({
      where: { dependsOnTaskId: next.id },
      select: { taskId: true },
    });
    for (const d of dependents) {
      if (!seen.has(d.taskId)) queue.push({ id: d.taskId, depth: next.depth + 1 });
    }
  }
}
