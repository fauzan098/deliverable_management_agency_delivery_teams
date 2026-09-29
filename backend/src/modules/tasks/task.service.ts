import { assertCan, can, canSeeTask, readScope } from '../../core/authz/authorize.ts';
import { type Blocker, permittedTransitions } from '../../core/authz/transition-policy.ts';
import type { Actor, TaskResource } from '../../core/authz/types.ts';
import { AppError } from '../../lib/errors.ts';
import { prisma, type SoftDeleteClient } from '../../lib/prisma.ts';
import { type ListMeta, type ListResult, runQuery, taskListSpec } from '../../lib/query.ts';
import { type Tx, writeCreatedLog, writeDiff, writeLog } from './audit.service.ts';
import { getBlockers, getDependents, getPrerequisites, reconcileSubgraph } from './dependency.service.ts';
import {
  type ClientTaskDto,
  type TaskDetailDto,
  type TaskSummaryDto,
  toClientTask,
  toFullAttachment,
  toFullComment,
  toTaskSummary,
} from './dto.ts';

const taskSelect = {
  id: true,
  projectId: true,
  title: true,
  description: true,
  status: true,
  priority: true,
  department: true,
  isClientVisible: true,
  version: true,
  orderIndex: true,
  estimateHours: true,
  dueDate: true,
  startedAt: true,
  completedAt: true,
  createdAt: true,
  updatedAt: true,
  assigneeId: true,
  project: { select: { id: true, name: true, code: true, clientOrgId: true } },
  assignee: { select: { id: true, name: true, email: true, avatarUrl: true, department: true, role: true } },
  createdBy: { select: { id: true, name: true, email: true, avatarUrl: true, department: true, role: true } },
} as const;

/**
 * Load the minimal projection the authorisation policy needs.
 *
 * Authorisation is evaluated against a narrow, explicit shape rather than the
 * full row: the policy should be unable to accidentally depend on a field that
 * is not part of the decision (e.g. it must not be able to read `isClientVisible`
 * to decide a *write*, because that flag is a PM-controlled input).
 */
export async function loadTaskResource(tx: Tx, taskId: string): Promise<TaskResource> {
  const row = await tx.task.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      projectId: true,
      assigneeId: true,
      department: true,
      isClientVisible: true,
      status: true,
      project: { select: { clientOrgId: true } },
    },
  });
  if (!row) throw AppError.notFound('Task', taskId);
  return {
    id: row.id,
    projectId: row.projectId,
    projectClientOrgId: row.project.clientOrgId,
    assigneeId: row.assigneeId,
    department: row.department,
    isClientVisible: row.isClientVisible,
    status: row.status,
  };
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

/**
 * `GET /api/projects/:id/tasks` — the standard list contract.
 *
 * The caller's visibility is applied as a mandatory `scope` that the client's
 * own filters cannot loosen, so `isClientVisible` and project membership are
 * enforced by the query, not by the client.
 */
export async function listTasks(
  actor: Actor,
  args: { projectId: string; params: Record<string, string | string[] | undefined> },
): Promise<ListResult<TaskSummaryDto | ClientTaskDto>> {
  const project = await prisma.project.findUnique({
    where: { id: args.projectId },
    select: { id: true, clientOrgId: true },
  });
  if (!project) throw AppError.notFound('Project', args.projectId);

  // A member of a project the actor cannot see gets 404, not 403: revealing
  // that a project exists is itself a small disclosure.
  if (!readScopeProject(actor, project)) {
    throw AppError.notFound('Project', args.projectId);
  }

  const isGuest = actor.role === 'CLIENT_GUEST';

  const scope: Record<string, unknown> = {
    projectId: args.projectId,
    ...(isGuest
      ? {
          // The tenant boundary, restated in the query. Defence in depth: the
          // project's org was already checked above, and a CLIENT_GUEST's own
          // clientOrgId comes from the JWT.
          project: { clientOrgId: actor.clientOrgId ?? '__none__' },
          isClientVisible: true,
        }
      : {}),
  };

  const result = await runQuery<TaskSummaryDto | ClientTaskDto, any>({
    params: args.params,
    delegate: prisma.task,
    spec: taskListSpec,
    scope,
    stableOrderBy: { orderIndex: 'asc' },
    include: { assignee: true, project: true },
    transform: (rows) =>
      isGuest ? (rows as any[]).map((r) => toClientTask(r)) : (rows as any[]).map((r) => toTaskSummary(r)),
  });

  return result;
}

function readScopeProject(actor: Actor, project: { id: string; clientOrgId: string }): boolean {
  if (actor.role === 'PRODUCT_MANAGER') return true;
  if (actor.role === 'INTERNAL_TEAM') return actor.projectIds.includes(project.id);
  return project.clientOrgId === actor.clientOrgId;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * `GET /api/tasks/:id`.
 *
 * A CLIENT_GUEST receives the masked projection. Note the asymmetry that
 * satisfies the brief precisely: the guest *can* be told that a task is gated
 * on internal work (`dependencies.allDone`) without ever learning which task,
 * who owns it, or which department it belongs to.
 */
export async function getTask(actor: Actor, taskId: string): Promise<TaskDetailDto | ClientTaskDto> {
  const resource = await loadTaskResource(prisma, taskId);
  assertCan(actor, 'task:read', resource);

  if (actor.role === 'CLIENT_GUEST') {
    const row = await prisma.task.findUnique({
      where: { id: taskId },
      include: {
        project: { select: { id: true, name: true } },
        attachments: { orderBy: { createdAt: 'desc' } },
        comments: { where: { isInternal: false }, orderBy: { createdAt: 'asc' } },
        prerequisites: { include: { dependsOnTask: { select: { status: true } } } },
      },
    });
    return toClientTask(row as any);
  }

  const [row, prerequisites, dependents, blockers] = await Promise.all([
    prisma.task.findUnique({
      where: { id: taskId },
      select: taskSelect,
    }),
    getPrerequisites(prisma, taskId),
    getDependents(prisma, taskId),
    getBlockers(prisma, taskId),
  ]);

  const [attachments, comments] = await Promise.all([
    prisma.attachment.findMany({
      where: { taskId },
      orderBy: { createdAt: 'desc' },
      include: {
        uploadedBy: { select: { id: true, name: true, email: true, avatarUrl: true, department: true, role: true } },
      },
    }),
    prisma.comment.findMany({
      where: { taskId },
      orderBy: { createdAt: 'asc' },
      include: {
        author: { select: { id: true, name: true, email: true, avatarUrl: true, department: true, role: true } },
      },
    }),
  ]);

  const summary = toTaskSummary(row as any);
  const transitions = permittedTransitions(actor, resource, blockers);

  /**
   * The permission map travels with the resource. The board uses it to decide
   * which controls to render disabled, and the reasons are the same strings
   * the API would reject with — so a locked button always corresponds to a real
   * server-side rule, never to a client-side guess.
   */
  const permissions = Object.fromEntries(
    (
      [
        'task:updateCore',
        'task:updateMeta',
        'task:setClientVisible',
        'task:manageDependencies',
        'task:softDelete',
        'task:readLogs',
        'attachment:upload',
        'comment:create',
      ] as const
    ).map((action) => [action, can(actor, action, resource).allowed]),
  );

  return {
    ...summary,
    description: row?.description ?? null,
    createdBy: row?.createdBy ? toTaskSummaryUser(row.createdBy) : null,
    startedAt: row?.startedAt ?? null,
    completedAt: row?.completedAt ?? null,
    blockers,
    prerequisites: prerequisites.map((p: (typeof prerequisites)[number]) => ({
      id: p.id,
      taskId: p.dependsOnTask.id,
      title: p.dependsOnTask.title,
      status: p.dependsOnTask.status,
      department: p.dependsOnTask.department,
    })),
    dependents: dependents.map((d: (typeof dependents)[number]) => ({
      id: d.id,
      taskId: d.task.id,
      title: d.task.title,
      status: d.task.status,
      department: d.task.department,
    })),
    attachments: attachments.map((a) => toFullAttachment(a as any)),
    comments: comments.map((c) => toFullComment(c as any)),
    permittedTransitions: transitions.map((t) => ({
      to: t.to,
      allowed: t.allowed,
      ...(t.code ? { code: t.code } : {}),
      ...(t.message ? { message: t.message } : {}),
    })),
    permissions,
  };
}

const toTaskSummaryUser = (u: {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  department: string | null;
  role: any;
}) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  avatarUrl: u.avatarUrl,
  role: u.role,
  department: u.department,
});

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreateTaskInput {
  projectId: string;
  title: string;
  description?: string | null;
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
  department: 'PRODUCT' | 'UI_UX' | 'FRONTEND' | 'BACKEND';
  assigneeId?: string | null;
  isClientVisible: boolean;
  dueDate?: Date | null;
  estimateHours?: number | null;
  orderIndex?: number;
}

export async function createTask(actor: Actor, input: CreateTaskInput): Promise<TaskDetailDto> {
  const project = await prisma.project.findUnique({
    where: { id: input.projectId },
    select: { id: true, clientOrgId: true, _count: { select: { tasks: true } } },
  });
  if (!project) throw AppError.notFound('Project', input.projectId);

  assertCan(actor, 'task:create', { id: project.id, clientOrgId: project.clientOrgId, status: 'ACTIVE' });

  if (input.assigneeId) {
    const assignee = await prisma.user.findUnique({
      where: { id: input.assigneeId },
      select: { id: true, deletedAt: true },
    });
    if (!assignee) throw AppError.notFound('User', input.assigneeId);
  }

  const task = await prisma.$transaction(async (tx) => {
    const created = await tx.task.create({
      data: {
        projectId: input.projectId,
        title: input.title,
        description: input.description ?? null,
        priority: input.priority,
        department: input.department,
        assigneeId: input.assigneeId ?? null,
        createdById: actor.id,
        isClientVisible: input.isClientVisible,
        dueDate: input.dueDate ?? null,
        estimateHours: input.estimateHours ?? null,
        orderIndex: input.orderIndex ?? project._count.tasks,
        // A task with no prerequisites is immediately workable; a task that
        // starts blocked only does so once an edge exists.
        status: 'TODO',
      },
    });

    await writeCreatedLog(tx, {
      taskId: created.id,
      projectId: created.projectId,
      userId: actor.id,
      snapshot: {
        title: created.title,
        description: created.description,
        status: created.status,
        priority: created.priority,
        department: created.department,
        assigneeId: created.assigneeId,
        isClientVisible: created.isClientVisible,
        dueDate: created.dueDate,
      },
    });

    return created;
  });

  return getTask(actor, task.id) as Promise<TaskDetailDto>;
}

// ---------------------------------------------------------------------------
// Update (optimistic locking)
// ---------------------------------------------------------------------------

/** Fields a PRODUCT_MANAGER may change — the "core" of the task. */
const CORE_FIELDS = ['title', 'description', 'priority', 'department'] as const;
/** Scheduling fields an assignee may also change. */
const META_FIELDS = ['dueDate', 'estimateHours', 'assigneeId', 'orderIndex'] as const;

export interface UpdateTaskInput {
  id: string;
  /** The version the client last read. Mandatory: without it a write is unsafe. */
  version: number;
  title?: string;
  description?: string | null;
  priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
  department?: 'PRODUCT' | 'UI_UX' | 'FRONTEND' | 'BACKEND';
  dueDate?: Date | null;
  estimateHours?: number | null;
  assigneeId?: string | null;
  orderIndex?: number;
  isClientVisible?: boolean;
}

export async function updateTask(actor: Actor, input: UpdateTaskInput): Promise<TaskDetailDto> {
  const resource = await loadTaskResource(prisma, input.id);

  // Split the requested fields by who is allowed to touch them, rather than
  // making the caller decide. A field the actor may not change is dropped
  // *and* logged as a denial, so a mixed payload cannot smuggle a core edit
  // through by also including an allowed field.
  const requestedCore = CORE_FIELDS.filter((f) => input[f] !== undefined);
  const requestedMeta = META_FIELDS.filter((f) => input[f] !== undefined);
  const wantsVisibility = input.isClientVisible !== undefined;

  if (requestedCore.length > 0 || wantsVisibility) {
    assertCan(actor, 'task:updateCore', resource);
  }
  if (wantsVisibility) {
    assertCan(actor, 'task:setClientVisible', resource);
  }
  if (requestedMeta.length > 0) {
    assertCan(actor, 'task:updateMeta', resource);
  }

  if (requestedMeta.includes('assigneeId') || wantsVisibility) {
    assertCan(actor, 'task:updateMeta', resource);
  }

  const fields = [
    ...requestedCore,
    ...requestedMeta,
    ...(wantsVisibility ? (['isClientVisible'] as const) : []),
  ] as string[];

  if (fields.length === 0) {
    throw new AppError('VALIDATION_ERROR', 'No updatable fields were provided');
  }

  if (input.assigneeId) {
    const assignee = await prisma.user.findUnique({ where: { id: input.assigneeId }, select: { id: true } });
    if (!assignee) throw AppError.notFound('User', input.assigneeId);
  }

  const data: Record<string, unknown> = {};
  for (const f of fields) data[f] = input[f as keyof UpdateTaskInput];

  const result = await prisma.$transaction(async (tx) => {
    const before = await tx.task.findUnique({
      where: { id: input.id },
      select: { version: true, ...Object.fromEntries(fields.map((f) => [f, true])) } as any,
    });
    if (!before) throw AppError.notFound('Task', input.id);

    /**
     * The optimistic lock.
     *
     * `where: { id, version }` makes the check-and-set a single atomic SQL
     * statement. If a PM is editing a description while an engineer sets the
     * same task to DONE in the same second, exactly one of them matches the
     * version they read; the loser gets zero rows back and is told so, instead
     * of silently clobbering the winner.
     *
     * This is deliberately `updateMany` + a re-read rather than `update`: the
     * affected-row count is the signal, and it cannot be lost to a
     * read-modify-write race.
     */
    const updated = await tx.task.updateMany({
      where: { id: input.id, version: input.version },
      data: { ...data, version: { increment: 1 } },
    });

    if (updated.count === 0) {
      const current = await tx.task.findUnique({ where: { id: input.id }, select: taskSelect });
      throw AppError.versionConflict(
        {
          id: current?.id,
          version: current?.version,
          status: current?.status,
          updatedAt: current?.updatedAt,
        },
        { expectedVersion: input.version },
      );
    }

    await writeDiff(tx, {
      taskId: input.id,
      projectId: resource.projectId,
      userId: actor.id,
      before: before as Record<string, unknown>,
      fields,
      after: { ...(before as Record<string, unknown>), ...data },
    });

    return tx.task.findUnique({ where: { id: input.id }, select: taskSelect });
  });

  return getTask(actor, result!.id) as Promise<TaskDetailDto>;
}

// ---------------------------------------------------------------------------
// Soft delete
// ---------------------------------------------------------------------------

/**
 * Soft delete. The row stays, `deletedAt` is stamped, the Prisma extension
 * hides it from every subsequent read, and the event is recorded. Nothing is
 * ever removed.
 */
export async function softDeleteTask(actor: Actor, args: { id: string; version: number }): Promise<void> {
  const resource = await loadTaskResource(prisma, args.id);
  assertCan(actor, 'task:softDelete', resource);

  await prisma.$transaction(async (tx) => {
    const updated = await tx.task.updateMany({
      where: { id: args.id, version: args.version },
      data: { deletedAt: new Date(), version: { increment: 1 } },
    });

    if (updated.count === 0) {
      const current = await tx.task.findUnique({ where: { id: args.id }, select: { id: true, version: true } });
      throw AppError.versionConflict({ id: current?.id, version: current?.version }, { expectedVersion: args.version });
    }

    await writeLog(tx, {
      taskId: args.id,
      projectId: resource.projectId,
      userId: actor.id,
      action: 'SOFT_DELETED',
      column: 'deletedAt',
      oldValue: null,
      newValue: new Date().toISOString(),
    });
  });
}

// ---------------------------------------------------------------------------
// Board metrics
// ---------------------------------------------------------------------------

/**
 * Aggregate progress for a project. Safe for a CLIENT_GUEST: it contains
 * counts only, never identities.
 */
export async function getProjectMetrics(actor: Actor, projectId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, name: true, code: true, clientOrgId: true, status: true, dueDate: true },
  });
  if (!project) throw AppError.notFound('Project', projectId);

  if (!readScopeProject(actor, project)) throw AppError.notFound('Project', projectId);

  const isGuest = actor.role === 'CLIENT_GUEST';

  const byStatus = await prisma.task.groupBy({
    by: ['status'],
    where: {
      projectId,
      ...(isGuest ? { isClientVisible: true, project: { clientOrgId: actor.clientOrgId ?? '__none__' } } : {}),
    },
    _count: { _all: true },
  });

  const counts = Object.fromEntries(byStatus.map((r) => [r.status, r._count._all]));
  const total = byStatus.reduce((sum, r) => sum + r._count._all, 0);
  const done = counts.DONE ?? 0;
  const blocked = counts.BLOCKED ?? 0;

  return {
    projectId: project.id,
    projectName: project.name,
    status: project.status,
    dueDate: project.dueDate,
    totalTasks: total,
    /** Percentage complete, rounded to one decimal. The brief's "50% Complete". */
    completionPercent: total === 0 ? 0 : Math.round((done / total) * 1000) / 10,
    byStatus: {
      TODO: counts.TODO ?? 0,
      BLOCKED: blocked,
      IN_PROGRESS: counts.IN_PROGRESS ?? 0,
      IN_REVIEW: counts.IN_REVIEW ?? 0,
      DONE: done,
    },
    /** Populated only for internal roles — a guest must not learn this. */
    ...(isGuest ? {} : { byDepartment: await byDepartment(projectId) }),
  };
}

async function byDepartment(projectId: string) {
  const rows = await prisma.task.groupBy({
    by: ['department', 'status'],
    where: { projectId },
    _count: { _all: true },
  });

  const out: Record<string, { total: number; done: number; completionPercent: number }> = {};
  for (const row of rows) {
    const entry = out[row.department] ?? { total: 0, done: 0, completionPercent: 0 };
    out[row.department] = entry;
    entry.total += row._count._all;
    if (row.status === 'DONE') entry.done += row._count._all;
  }
  for (const entry of Object.values(out)) {
    entry.completionPercent = entry.total === 0 ? 0 : Math.round((entry.done / entry.total) * 1000) / 10;
  }
  return out;
}

export {
  reconcileSubgraph,
  canSeeTask,
  readScope,
  getBlockers,
  type Blocker,
  type Tx,
  type ListMeta,
  type SoftDeleteClient,
};
