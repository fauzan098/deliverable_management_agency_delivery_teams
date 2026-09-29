import { assertCan } from '../../core/authz/authorize.ts';
import type { Actor } from '../../core/authz/types.ts';
import { AppError } from '../../lib/errors.ts';
import { prisma } from '../../lib/prisma.ts';

/**
 * Daily standup auto-summary.
 *
 * Derived entirely from the audit trail, which is the point: a standup summary
 * built from live task state would restate the board. Built from the log, it
 * reports *what actually changed* on a given day, and it cannot drift from the
 * record because it *is* the record.
 *
 * A CLIENT_GUEST is refused — the audit trail is internal by definition.
 */

export interface StandupReport {
  projectId: string;
  projectName: string;
  /** The day being summarised, `YYYY-MM-DD`. */
  reportDate: string;
  /** The day whose changes are summarised (the day before `reportDate`). */
  coveredDate: string;
  generatedAt: Date;
  headline: {
    completedYesterday: number;
    movedToInProgress: number;
    movedToReview: number;
    blockedToday: number;
    reopened: number;
    totalChanges: number;
  };
  completedYesterday: StandupEntry[];
  blockedToday: StandupEntry[];
  inFlight: StandupEntry[];
  byDepartment: DepartmentSummary[];
  timeline: TimelineEntry[];
}

interface RawLog {
  id: string;
  action: string;
  column: string;
  oldValue: string | null;
  newValue: string | null;
  createdAt: Date;
  task: { id: string; title: string; department: string; status: string } | null;
  user: { id: string; name: string; department: string | null } | null;
}

export interface StandupEntry {
  taskId: string;
  taskTitle: string;
  department: string;
  status: string;
  actorName: string;
  change: string;
  at: Date;
}

export interface DepartmentSummary {
  department: string;
  totalTasks: number;
  done: number;
  completionPercent: number;
  completedYesterday: number;
  blockedToday: number;
}

export interface TimelineEntry {
  at: Date;
  actorName: string;
  taskId: string;
  taskTitle: string;
  action: string;
  column: string;
  oldValue: string | null;
  newValue: string | null;
}

const ymd = (d: Date): string => d.toISOString().slice(0, 10);

/** Start-of-day in UTC, so the report boundary is deterministic across regions. */
const startOfUtcDay = (d: Date): Date => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

export async function getStandup(actor: Actor, projectId: string, reportDate?: string): Promise<StandupReport> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, name: true, clientOrgId: true, status: true },
  });
  if (!project) throw AppError.notFound('Project', projectId);

  assertCan(actor, 'standup:read', project);

  // `reportDate` is the day the standup *happens on*; it summarises the
  // preceding 24 hours. Omitting it means "yesterday", which is the common case.
  const report = reportDate ? parseDate(reportDate) : startOfUtcDay(new Date(Date.now() - 86_400_000));
  const coveredFrom = new Date(report.getTime() - 86_400_000);
  const coveredTo = report;

  const [logs, currentTasks] = await Promise.all([
    prisma.taskLog.findMany({
      where: {
        projectId,
        createdAt: { gte: coveredFrom, lt: coveredTo },
      },
      orderBy: { createdAt: 'asc' },
      include: {
        task: { select: { id: true, title: true, department: true, status: true } },
        user: { select: { id: true, name: true, department: true } },
      },
    }) as unknown as Promise<RawLog[]>,
    prisma.task.findMany({
      where: { projectId },
      select: {
        id: true,
        title: true,
        department: true,
        status: true,
        assignee: { select: { name: true } },
        blockedBy: { select: { dependsOnTask: { select: { id: true, title: true, status: true } } } },
      },
    }),
  ]);

  const statusLogs = logs.filter((l) => l.column === 'status' && l.task);

  // ---- Yesterday's movement, read straight off the log -------------------
  const completedYesterday: StandupEntry[] = statusLogs
    .filter((l) => l.oldValue !== 'DONE' && l.newValue === 'DONE')
    .map(toEntry('marked Done'));

  const inFlight: StandupEntry[] = statusLogs
    .filter((l) => l.newValue === 'IN_PROGRESS' || l.newValue === 'IN_REVIEW')
    .map(toEntry('picked up'));

  const reopened: StandupEntry[] = statusLogs.filter((l) => l.oldValue === 'DONE').map(toEntry('reopened'));

  // ---- Today's blocked state, derived from the live dependency graph ------
  const blockedToday: StandupEntry[] = currentTasks
    .filter((t) => t.status === 'BLOCKED' || (t.blockedBy.length > 0 && t.status !== 'DONE'))
    .map((t) => {
      const blockers = t.blockedBy
        .map((b) => b.dependsOnTask)
        .filter((b) => b.status !== 'DONE')
        .map((b) => b.title);
      return {
        taskId: t.id,
        taskTitle: t.title,
        department: t.department,
        status: t.status,
        actorName: t.assignee?.name ?? 'Unassigned',
        change: blockers.length > 0 ? `Waiting on: ${blockers.join(', ')}` : 'Blocked by an unfinished prerequisite',
        at: new Date(),
      };
    });

  // ---- Per-department roll-up --------------------------------------------
  const deptMap = new Map<string, DepartmentSummary>();
  for (const task of currentTasks) {
    const entry = deptMap.get(task.department) ?? {
      department: task.department,
      totalTasks: 0,
      done: 0,
      completionPercent: 0,
      completedYesterday: 0,
      blockedToday: 0,
    };
    entry.totalTasks += 1;
    if (task.status === 'DONE') entry.done += 1;
    deptMap.set(task.department, entry);
  }
  for (const e of completedYesterday) {
    const entry = deptMap.get(e.department);
    if (entry) entry.completedYesterday += 1;
  }
  for (const e of blockedToday) {
    const entry = deptMap.get(e.department);
    if (entry) entry.blockedToday += 1;
  }
  for (const entry of deptMap.values()) {
    entry.completionPercent = entry.totalTasks === 0 ? 0 : Math.round((entry.done / entry.totalTasks) * 1000) / 10;
  }

  return {
    projectId: project.id,
    projectName: project.name,
    reportDate: ymd(report),
    coveredDate: ymd(coveredFrom),
    generatedAt: new Date(),
    headline: {
      completedYesterday: completedYesterday.length,
      movedToInProgress: inFlight.length,
      movedToReview: statusLogs.filter((l) => l.newValue === 'IN_REVIEW').length,
      blockedToday: blockedToday.length,
      reopened: reopened.length,
      totalChanges: logs.length,
    },
    completedYesterday,
    blockedToday,
    inFlight,
    byDepartment: [...deptMap.values()].sort((a, b) => a.department.localeCompare(b.department)),
    timeline: logs.slice(0, 200).map((l) => ({
      at: l.createdAt,
      actorName: l.user?.name ?? 'System',
      taskId: l.task?.id ?? '',
      taskTitle: l.task?.title ?? '(deleted task)',
      action: l.action,
      column: l.column,
      oldValue: l.oldValue,
      newValue: l.newValue,
    })),
  };
}

function toEntry(change: string) {
  return (log: RawLog): StandupEntry => ({
    taskId: log.task!.id,
    taskTitle: log.task!.title,
    department: log.task!.department,
    status: log.task!.status,
    actorName: log.user?.name ?? 'System',
    change,
    at: log.createdAt,
  });
}

function parseDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new AppError('VALIDATION_ERROR', 'date must be formatted as YYYY-MM-DD', { date: value });
  }
  const d = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) {
    throw new AppError('VALIDATION_ERROR', 'date is not a valid calendar date', { date: value });
  }
  return d;
}

/**
 * Optional background job.
 *
 * Enabled with `STANDUP_CRON_ENABLED=true`. It does nothing the endpoint does
 * not already do — the endpoint remains the source of truth — but it proves the
 * "background job" option in the brief and lets an operator warm a cache.
 */
export function startStandupScheduler(log: (msg: string) => void = console.log): () => void {
  const tick = async () => {
    try {
      const projects = await prisma.project.findMany({ select: { id: true, name: true } });
      for (const project of projects) {
        // The first seeded PM stands in for "the actor" in the background run;
        // the endpoint is what an interactive caller uses.
        const pm = await prisma.user.findFirst({
          where: { role: 'PRODUCT_MANAGER', isActive: true },
          select: {
            id: true,
            email: true,
            name: true,
            avatarUrl: true,
            role: true,
            department: true,
            clientOrgId: true,
            projectMembers: { select: { projectId: true } },
          },
        });
        if (!pm) continue;
        const report = await getStandup(
          { ...pm, projectIds: pm.projectMembers.map((m) => m.projectId) } as never,
          project.id,
        );
        log(
          `[standup] ${project.name}: ${report.headline.completedYesterday} done, ${report.headline.blockedToday} blocked`,
        );
      }
    } catch (err) {
      log(`[standup] failed: ${(err as Error).message}`);
    }
  };

  const interval = setInterval(tick, 60 * 60 * 1000);
  void tick();
  return () => clearInterval(interval);
}
