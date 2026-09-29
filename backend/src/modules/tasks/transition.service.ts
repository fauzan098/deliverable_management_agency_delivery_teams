import { type Blocker, canTransition, label } from '../../core/authz/transition-policy.ts';
import type { Actor } from '../../core/authz/types.ts';
import { AppError } from '../../lib/errors.ts';
import { prisma } from '../../lib/prisma.ts';
import { type Tx, writeLog } from './audit.service.ts';
import { getBlockers, reconcileSubgraph } from './dependency.service.ts';
import type { TaskDetailDto } from './dto.ts';
import { getTask, loadTaskResource } from './task.service.ts';

/**
 * Status transitions.
 *
 * This is the one endpoint where all four hard requirements of the brief meet:
 * a role check, a state check, a dependency check, and a concurrency check —
 * in that order, all inside one transaction.
 */

export interface TransitionInput {
  taskId: string;
  to: 'TODO' | 'BLOCKED' | 'IN_PROGRESS' | 'IN_REVIEW' | 'DONE';
  /** The version the client last read. Mandatory. */
  version: number;
  note?: string;
}

export async function transitionTask(actor: Actor, input: TransitionInput): Promise<TaskDetailDto> {
  const resource = await loadTaskResource(prisma, input.taskId);

  const from = resource.status;
  if (from === input.to) {
    throw new AppError('INVALID_TRANSITION', `Task is already ${label(input.to)}`, { status: from });
  }

  return prisma
    .$transaction(async (tx) => {
      // Re-read inside the transaction so the decision is made against the state
      // we are actually going to write, not a state that may already be stale.
      const fresh = await loadTaskResource(tx, input.taskId);
      const blockers: Blocker[] = await getBlockers(tx, input.taskId);

      // 1. Role + state + dependency, as one decision.
      const decision = canTransition(actor, fresh, { from: fresh.status, to: input.to, blockers });
      if (!decision.allowed) {
        throw new AppError(decision.code, decision.message, {
          from: fresh.status,
          to: input.to,
          reason: decision.reason,
          ...(blockers.length > 0
            ? { blockers: blockers.map((b) => ({ taskId: b.taskId, title: b.title, status: b.status })) }
            : {}),
        });
      }

      const now = new Date();

      // 2. The write itself, guarded on the version the caller read.
      const updated = await tx.task.updateMany({
        where: { id: input.taskId, version: input.version },
        data: {
          status: input.to,
          version: { increment: 1 },
          ...(input.to === 'IN_PROGRESS' && fresh.status === 'TODO' ? { startedAt: now } : {}),
          ...(input.to === 'DONE' ? { completedAt: now } : {}),
          // Leaving DONE (a reopen) clears the completion stamp.
          ...(fresh.status === 'DONE' && input.to !== 'DONE' ? { completedAt: null } : {}),
        },
      });

      // 3. Concurrency. Zero rows means another writer advanced the version while
      //    this request was in flight — report it rather than overwrite.
      if (updated.count === 0) {
        const current = await tx.task.findUnique({
          where: { id: input.taskId },
          select: { id: true, version: true, status: true, updatedAt: true },
        });
        throw AppError.versionConflict(
          { id: current?.id, version: current?.version, status: current?.status, updatedAt: current?.updatedAt },
          { expectedVersion: input.version, attemptedTransition: { from, to: input.to } },
        );
      }

      await writeLog(tx, {
        taskId: input.taskId,
        projectId: fresh.projectId,
        userId: actor.id,
        action: 'STATUS_CHANGED',
        column: 'status',
        oldValue: fresh.status,
        newValue: input.to,
        ...(input.note ? { metadata: { note: input.note, blockersSatisfied: blockers.length } } : {}),
      });

      // 4. Settle everything downstream. A task reaching DONE can unblock a whole
      //    chain, so the reconciler walks the affected subtree before we commit.
      await reconcileSubgraph(tx, input.taskId, { userId: actor.id });

      return tx.task.findUnique({ where: { id: input.taskId }, select: { id: true } });
    })
    .then((row) => getTask(actor, (row as { id: string }).id) as Promise<TaskDetailDto>);
}

/**
 * `GET /api/tasks/:id/transition-options` — which transitions this viewer could
 * take right now, and why not.
 *
 * The board renders disabled buttons with the reason attached. Because these
 * come from the same `canTransition` used for enforcement, a control can never
 * be locked in the UI while the API would have permitted it, or vice versa.
 */
export async function transitionOptions(actor: Actor, taskId: string) {
  const resource = await loadTaskResource(prisma, taskId);
  const blockers = await getBlockers(prisma, taskId);

  return {
    taskId,
    currentStatus: resource.status,
    blockers: blockers.map((b) => ({ taskId: b.taskId, title: b.title, status: b.status })),
    options: (['TODO', 'BLOCKED', 'IN_PROGRESS', 'IN_REVIEW', 'DONE'] as const)
      .filter((to) => to !== resource.status)
      .map((to) => {
        const decision = canTransition(actor, resource, { from: resource.status, to, blockers });
        return {
          to,
          allowed: decision.allowed,
          ...(decision.allowed ? {} : { code: decision.code, reason: decision.reason, message: decision.message }),
        };
      }),
  };
}

export type { Tx };
