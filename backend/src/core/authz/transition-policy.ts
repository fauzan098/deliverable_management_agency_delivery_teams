import type { TaskStatus } from '../../generated/prisma/enums.ts';
import { type Actor, ALLOW, type Decision, deny, type TaskResource } from './types.ts';

/**
 * The task state machine.
 *
 * Status is not a free-text field that anyone may set to any value. Two
 * independent gates apply to every transition:
 *
 *   1. **Structural** — is `from -> to` a legal edge at all? (this file)
 *   2. **Attribute** — may *this* actor take *this* edge, and are the task's
 *      prerequisites satisfied? (`canTransition`)
 *
 * Keeping them separate means the same rules drive the server (enforcement) and
 * the board UI (which buttons to disable), without the frontend re-deriving any
 * business logic of its own.
 */

export const TASK_STATUSES: TaskStatus[] = ['TODO', 'BLOCKED', 'IN_PROGRESS', 'IN_REVIEW', 'DONE'];

/** Legal edges. Anything absent here is rejected with INVALID_TRANSITION. */
const ALLOWED_EDGES = new Map<TaskStatus, readonly TaskStatus[]>([
  // BLOCKED is a derived state: a dependency is unsatisfied. It can only be
  // left by the reconciler (to TODO) or by starting work once the blocker
  // clears (to IN_PROGRESS).
  ['TODO', ['BLOCKED', 'IN_PROGRESS']],
  ['BLOCKED', ['TODO', 'IN_PROGRESS']],
  // IN_PROGRESS -> DONE is the straight-through path the brief describes ("the
  // executor can complete it"); IN_REVIEW -> DONE is the same act after a review
  // pass. A PM is refused on *both*, which is what `PM_CANNOT_COMPLETE` enforces
  // in the attribute gate below.
  ['IN_PROGRESS', ['BLOCKED', 'IN_REVIEW', 'TODO', 'DONE']],
  ['IN_REVIEW', ['IN_PROGRESS', 'DONE']],
  // Reopen: a rejected deliverable goes back into the flow. Not PM-only — the
  // attribute gate below still applies, so in practice the assignee can reopen
  // their own work and a PM can reopen anything.
  ['DONE', ['IN_PROGRESS', 'TODO']],
]);

export function isLegalTransition(from: TaskStatus, to: TaskStatus): boolean {
  return (ALLOWED_EDGES.get(from) ?? []).includes(to);
}

export const legalTargetsFrom = (from: TaskStatus): TaskStatus[] => [...(ALLOWED_EDGES.get(from) ?? [])];

/** The statuses the board renders as columns, in pipeline order. */
export const BOARD_COLUMNS: TaskStatus[] = TASK_STATUSES;

/** A prerequisite that is not yet DONE. */
export interface Blocker {
  taskId: string;
  title: string;
  status: TaskStatus;
}

export interface TransitionContext {
  from: TaskStatus;
  to: TaskStatus;
  /** Prerequisite tasks not yet DONE. Empty when the task is unblocked. */
  blockers: Blocker[];
  /** The transition is being performed by the dependency reconciler, not a user. */
  systemInitiated?: boolean;
}

/**
 * Decide whether `actor` may move `task` from its current status to `to`.
 *
 * The rules that make this system more than CRUD:
 *
 *  - **PM cannot complete a task.** Per the brief, moving work to DONE is the
 *    executor's act. A PM may *review* and may *reopen*, but confirming
 *    completion is reserved for the assignee. This is enforced here, not in the
 *    controller, so there is no route to DONE that bypasses it.
 *  - **Only the assignee moves their own work.** A non-assignee internal member
 *    is refused even for a legal edge.
 *  - **Dependencies gate progress, not just visibility.** Reaching IN_PROGRESS
 *    with an unsatisfied prerequisite fails with DEPENDENCY_NOT_MET and returns
 *    the blocking tasks so the UI can say *which* ones.
 *  - **Clients are read-only everywhere.**
 */
export function canTransition(actor: Actor, task: TaskResource, ctx: TransitionContext): Decision {
  const { from, to, blockers } = ctx;

  if (actor.role === 'CLIENT_GUEST') {
    return deny('FORBIDDEN', 'Clients have read-only access to this board', 'client-guest-readonly');
  }

  if (from === to) {
    return deny('INVALID_TRANSITION', `Task is already ${label(to)}`, 'no-op-transition');
  }

  // Gate 1 — structural.
  if (!isLegalTransition(from, to)) {
    return deny('INVALID_TRANSITION', `A task cannot move from ${label(from)} to ${label(to)}`, 'illegal-state-edge');
  }

  const isPm = actor.role === 'PRODUCT_MANAGER';
  const isAssignee = task.assigneeId === actor.id;

  // Gate 2 — attribute.
  if (isPm) {
    // The one carve-out in the entire policy.
    if (to === 'DONE') {
      return deny(
        'PM_CANNOT_COMPLETE',
        'Only the assignee who executed the work can mark a task Done. Ask the assignee to complete it.',
        'pm-cannot-complete',
      );
    }
  } else if (!isAssignee) {
    return deny('NOT_ASSIGNEE', `Only the assigned ${task.department} engineer can move this task`, 'not-the-assignee');
  }

  // Gate 3 — dependency satisfaction. Applies to everyone.
  //
  // Note this deliberately does not apply to a task that is already past
  // IN_REVIEW: once work has started we do not forcibly rewind the board if a
  // prerequisite is reopened by someone else — that is an escalation, not a
  // state error, and silently un-starting someone's task would be worse. The
  // reconciler surfaces it as a BLOCKED badge instead.
  const startingWork = to === 'IN_PROGRESS' && from !== 'IN_PROGRESS' && from !== 'IN_REVIEW';
  if (startingWork && blockers.length > 0) {
    return deny(
      'DEPENDENCY_NOT_MET',
      `This task is blocked by ${blockers.length} unfinished ${blockers.length === 1 ? 'task' : 'tasks'}`,
      'dependency-not-met',
    );
  }

  return ALLOW;
}

/** The per-status transitions an actor could take, for disabling board buttons. */
export interface PermittedTransition {
  to: TaskStatus;
  allowed: boolean;
  code?: string;
  message?: string;
}

export function permittedTransitions(actor: Actor, task: TaskResource, blockers: Blocker[]): PermittedTransition[] {
  return legalTargetsFrom(task.status).map((to) => {
    const decision = canTransition(actor, task, { from: task.status, to, blockers });
    return decision.allowed
      ? { to, allowed: true }
      : { to, allowed: false, code: decision.code, message: decision.message };
  });
}

const STATUS_LABELS: Record<TaskStatus, string> = {
  TODO: 'To Do',
  BLOCKED: 'Blocked',
  IN_PROGRESS: 'In Progress',
  IN_REVIEW: 'In Review',
  DONE: 'Done',
};

export const label = (status: TaskStatus): string => STATUS_LABELS[status];
