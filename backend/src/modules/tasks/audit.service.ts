import type { Prisma, TaskLogAction } from '../../generated/prisma/client.ts';
import type { SoftDeleteClient } from '../../lib/prisma.ts';

/**
 * The audit trail.
 *
 * Every mutation in this system writes here, inside the same transaction as the
 * change itself. Two independent guarantees make the trail trustworthy:
 *
 *  - **Application** — the only way to write a `TaskLog` is through
 *    `writeLog`/`writeDiff`, and there is no update or delete path at all.
 *  - **Database** — a `BEFORE UPDATE OR DELETE` trigger on `task_logs` raises
 *    an exception, so even `psql` cannot rewrite history. See
 *    `prisma/migrations/*_task_log_immutability`.
 *
 * Each row records who, when, which column, and the old and new values, as the
 * brief requires.
 */

/**
 * Services accept either the long-lived client or a transaction handle, so the
 * same service function works standalone and inside `prisma.$transaction`.
 */
export type Tx = Pick<
  SoftDeleteClient,
  'task' | 'taskLog' | 'taskDependency' | 'project' | 'user' | 'comment' | 'attachment'
>;

/** A single field-level change, as produced by diffing two snapshots. */
export interface FieldChange {
  action: TaskLogAction;
  column: string;
  oldValue: unknown;
  newValue: unknown;
}

/**
 * Maps a field name to the audit action that describes changing it, so that a
 * status change is recorded as `STATUS_CHANGED` rather than a generic
 * `UPDATED` and the standup summary can filter on meaning rather than strings.
 */
const ACTION_BY_COLUMN: Record<string, TaskLogAction> = {
  status: 'STATUS_CHANGED',
  assigneeId: 'REASSIGNED',
  description: 'DESCRIPTION_CHANGED',
  title: 'DESCRIPTION_CHANGED',
  isClientVisible: 'VISIBILITY_CHANGED',
};

const actionFor = (column: string, fallback: TaskLogAction = 'UPDATED'): TaskLogAction =>
  ACTION_BY_COLUMN[column] ?? fallback;

const serialise = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
};

/**
 * Serialise for storage, truncating very large values so a description rewrite
 * cannot bloat the log table. The truncation is explicit (`…[truncated]`) so it
 * is never mistaken for the real value.
 */
const MAX_VALUE_LENGTH = 4000;
const serialiseBounded = (value: unknown): string | null => {
  const str = serialise(value);
  if (str === null) return null;
  return str.length > MAX_VALUE_LENGTH ? `${str.slice(0, MAX_VALUE_LENGTH)}…[truncated]` : str;
};

/** Write one entry. Must be called with a transaction handle. */
export async function writeLog(
  tx: Tx,
  entry: {
    taskId: string;
    projectId: string;
    userId: string;
    action: TaskLogAction;
    column: string;
    oldValue?: unknown;
    newValue?: unknown;
    metadata?: Prisma.InputJsonValue;
  },
): Promise<void> {
  await tx.taskLog.create({
    data: {
      taskId: entry.taskId,
      projectId: entry.projectId,
      userId: entry.userId,
      action: entry.action,
      column: entry.column,
      oldValue: serialiseBounded(entry.oldValue),
      newValue: serialiseBounded(entry.newValue),
      ...(entry.metadata !== undefined ? { metadata: entry.metadata } : {}),
    },
  });
}

/** Write the `CREATED` entry for a brand-new task. */
export async function writeCreatedLog(
  tx: Tx,
  args: { taskId: string; projectId: string; userId: string; snapshot: Record<string, unknown> },
): Promise<void> {
  await writeLog(tx, {
    taskId: args.taskId,
    projectId: args.projectId,
    userId: args.userId,
    action: 'CREATED',
    column: 'task',
    oldValue: null,
    newValue: args.snapshot,
  });
}

/**
 * Diff two snapshots of the same task and record one entry per changed field.
 *
 * This is what makes "every change to any field must be recorded" true by
 * construction: callers pass the fields they intended to change plus the
 * previous state, and they cannot forget a field, because the log is derived
 * from the same object that drives the update.
 */
export async function writeDiff(
  tx: Tx,
  args: {
    taskId: string;
    projectId: string;
    userId: string;
    before: Record<string, unknown>;
    /** Only these keys are considered; the rest are ignored. */
    fields: string[];
    after: Record<string, unknown>;
    defaultAction?: TaskLogAction;
    metadata?: Prisma.InputJsonValue;
  },
): Promise<void> {
  const changes: FieldChange[] = [];

  for (const column of args.fields) {
    const before = args.before[column];
    const after = args.after[column];
    if (serialise(before) === serialise(after)) continue;
    changes.push({
      action: actionFor(column, args.defaultAction ?? 'UPDATED'),
      column,
      oldValue: before,
      newValue: after,
    });
  }

  if (changes.length === 0) return;

  for (const change of changes) {
    await writeLog(tx, {
      taskId: args.taskId,
      projectId: args.projectId,
      userId: args.userId,
      action: change.action,
      column: change.column,
      oldValue: change.oldValue,
      newValue: change.newValue,
      ...(args.metadata ? { metadata: args.metadata } : {}),
    });
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface AuditLogRow {
  id: string;
  taskId: string;
  projectId: string;
  userId: string;
  action: string;
  column: string;
  oldValue: string | null;
  newValue: string | null;
  metadata: unknown;
  createdAt: Date;
  user: { id: string; name: string; email: string; department: string | null; avatarUrl: string | null } | null;
  task: { id: string; title: string; deletedAt: Date | null } | null;
}

export async function listLogs(
  tx: Tx,
  args: { projectId: string; taskId?: string; since?: Date; until?: Date; take?: number; skip?: number },
): Promise<{ rows: AuditLogRow[]; total: number }> {
  const where = {
    projectId: args.projectId,
    ...(args.taskId ? { taskId: args.taskId } : {}),
    ...(args.since || args.until
      ? {
          createdAt: {
            ...(args.since ? { gte: args.since } : {}),
            ...(args.until ? { lt: args.until } : {}),
          },
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    tx.taskLog.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: args.take ?? 50,
      skip: args.skip ?? 0,
      include: {
        user: { select: { id: true, name: true, email: true, department: true, avatarUrl: true } },
        task: { select: { id: true, title: true, deletedAt: true } },
      },
    }),
    tx.taskLog.count({ where }),
  ]);

  return { rows: rows as unknown as AuditLogRow[], total };
}
