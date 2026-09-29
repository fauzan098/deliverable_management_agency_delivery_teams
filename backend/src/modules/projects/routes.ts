import { Hono } from 'hono';
import { z } from 'zod';
import { env } from '../../config/env.ts';
import { assertCan, canSeeTask } from '../../core/authz/authorize.ts';
import { AppError } from '../../lib/errors.ts';
import { prisma } from '../../lib/prisma.ts';
import type { AppEnv } from '../../middleware/auth.ts';
import { rateLimit } from '../../middleware/common.ts';
import {
  department,
  email as emailSchema,
  optionalDate,
  parseOrThrow,
  password,
  priority,
  projectStatus,
  safeText,
  taskStatus,
  uuid,
} from '../shared/schemas.ts';
import { listLogs, writeLog } from '../tasks/audit.service.ts';
import * as dependencyService from '../tasks/dependency.service.ts';
import { toFullAttachment, toFullComment } from '../tasks/dto.ts';
import * as taskService from '../tasks/task.service.ts';
import * as transitionService from '../tasks/transition.service.ts';
import * as projectService from './project.service.ts';

const actorOf = (c: any) => c.get('actor') as import('../../core/authz/types.ts').Actor;

/**
 * A version is always required for a mutating write.
 *
 * It may arrive as an `If-Match` header (the HTTP-correct way to express a
 * precondition) or in the body, because JSON clients handle the former less
 * conveniently. Either way, omitting it is a validation error rather than a
 * silent last-write-wins.
 */
const versionOf = (c: any, body?: { version?: number }): number => {
  const header = c.req.header('if-match')?.replace(/"/g, '');
  const raw = header ?? body?.version;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) {
    throw new AppError(
      'VALIDATION_ERROR',
      'A task version is required for this operation (send If-Match or "version")',
    );
  }
  return Math.floor(n);
};

export const projectRoutes = new Hono<AppEnv>()
  .get('/', async (c) => {
    const result = await projectService.listProjects(actorOf(c), c.req.query() as any);
    return c.json(result);
  })

  .post('/', async (c) => {
    const body = parseOrThrow(
      z.object({
        name: safeText(160),
        code: safeText(24).regex(/^[A-Za-z0-9-]+$/, 'Code may contain only letters, numbers and hyphens'),
        description: safeText(2000).nullish(),
        clientOrgId: uuid,
        startDate: optionalDate,
        dueDate: optionalDate,
        status: projectStatus.default('PLANNING'),
      }),
      await c.req.json(),
    );
    return c.json(await projectService.createProject(actorOf(c), body), 201);
  })

  .get('/:id', async (c) => {
    return c.json(await projectService.getProject(actorOf(c), c.req.param('id')));
  })

  .patch('/:id', async (c) => {
    const body = parseOrThrow(
      z.object({
        version: z.number().int().min(1).optional(),
        name: safeText(160).optional(),
        description: safeText(2000).nullish(),
        status: projectStatus.optional(),
        startDate: optionalDate,
        dueDate: optionalDate,
      }),
      await c.req.json(),
    );
    return c.json(
      await projectService.updateProject(actorOf(c), { id: c.req.param('id'), ...body, version: versionOf(c, body) }),
    );
  })

  .get('/:id/metrics', async (c) => {
    return c.json(await taskService.getProjectMetrics(actorOf(c), c.req.param('id')));
  })

  /**
   * The standard list contract, shared by every collection in this API:
   * `?filters=` `&searchFilters=` `&rangedFilters=` `&orderKey=` `&orderRule=`
   * `&page=` `&rows=`. The response is always `{ data, meta }`.
   */
  .get('/:id/tasks', async (c) => {
    const result = await taskService.listTasks(actorOf(c), {
      projectId: c.req.param('id'),
      params: c.req.query() as any,
    });
    return c.json(result);
  })

  .post('/:id/tasks', async (c) => {
    const projectId = c.req.param('id');
    const body = parseOrThrow(
      z.object({
        title: safeText(200),
        description: safeText(5000).nullish(),
        priority: priority.default('MEDIUM'),
        department,
        assigneeId: uuid.nullish(),
        isClientVisible: z.boolean().default(false),
        dueDate: optionalDate,
        estimateHours: z.coerce.number().nonnegative().nullish(),
        orderIndex: z.coerce.number().int().nonnegative().optional(),
      }),
      await c.req.json(),
    );
    return c.json(await taskService.createTask(actorOf(c), { projectId, ...body }), 201);
  })

  .get('/:id/members', async (c) => {
    return c.json({ data: await projectService.listMembers(actorOf(c), c.req.param('id')) });
  })

  /**
   * PM-only provisioning. This is the *only* way a CLIENT_GUEST account comes
   * into existence; self-registration cannot produce that role.
   */
  .post('/:id/members', async (c) => {
    const body = parseOrThrow(
      z.object({
        name: safeText(120),
        email: emailSchema,
        password,
        role: z.enum(['INTERNAL_TEAM', 'CLIENT_GUEST']),
        department: department.nullish(),
      }),
      await c.req.json(),
    );
    return c.json(await projectService.inviteMember(actorOf(c), { projectId: c.req.param('id'), ...body }), 201);
  })

  /**
   * Standup summary for a given day (defaults to yesterday).
   *
   * Computed from the audit trail rather than from a separate denormalised
   * table, so it can never drift from the record of what actually happened.
   */
  .get('/:id/standup', async (c) => {
    const { getStandup } = await import('../standup/standup.service.ts');
    const date = c.req.query('date');
    const result = await getStandup(actorOf(c), c.req.param('id'), date);
    return c.json(result);
  });

export const clientOrgRoutes = new Hono<AppEnv>().get('/', async (c) => {
  return c.json({ data: await projectService.listClientOrgs(actorOf(c)) });
});

export const taskRoutes = new Hono<AppEnv>()
  .get('/:id', async (c) => c.json(await taskService.getTask(actorOf(c), c.req.param('id'))))

  .patch('/:id', async (c) => {
    const body = parseOrThrow(
      z.object({
        version: z.number().int().min(1).optional(),
        title: safeText(200).optional(),
        description: safeText(5000).nullish(),
        priority: priority.optional(),
        department: department.optional(),
        dueDate: optionalDate,
        estimateHours: z.coerce.number().nonnegative().nullish(),
        assigneeId: uuid.nullish(),
        orderIndex: z.coerce.number().int().nonnegative().optional(),
        isClientVisible: z.boolean().optional(),
      }),
      await c.req.json(),
    );
    return c.json(
      await taskService.updateTask(actorOf(c), { id: c.req.param('id'), ...body, version: versionOf(c, body) }),
    );
  })

  .delete('/:id', async (c) => {
    const version = versionOf(c, Object.fromEntries(c.req.query() as any));
    await taskService.softDeleteTask(actorOf(c), { id: c.req.param('id'), version });
    return c.json({ message: 'Task archived' });
  })

  /**
   * The core state endpoint. Role, state, dependency and concurrency are all
   * checked here; see `transition.service.ts`.
   */
  .post('/:id/transition', async (c) => {
    const body = parseOrThrow(
      z.object({
        to: taskStatus,
        version: z.number().int().min(1).optional(),
        note: safeText(500).optional(),
      }),
      await c.req.json(),
    );
    return c.json(
      await transitionService.transitionTask(actorOf(c), {
        taskId: c.req.param('id'),
        to: body.to,
        version: versionOf(c, body),
        note: body.note,
      }),
    );
  })

  .get('/:id/transition-options', async (c) => {
    return c.json(await transitionService.transitionOptions(actorOf(c), c.req.param('id')));
  })

  .get('/:id/logs', async (c) => {
    const taskId = c.req.param('id');
    const resource = await taskService.loadTaskResource(prisma, taskId);
    assertCan(actorOf(c), 'task:readLogs', resource);

    const { rows, total } = await listLogs(prisma, {
      projectId: resource.projectId,
      taskId,
      take: Math.min(Number(c.req.query('rows') ?? 50), 200),
      skip: Number(c.req.query('page') ?? 1) * 0,
    });

    return c.json({ data: rows, meta: { total } });
  })

  .get('/:id/dependencies', async (c) => {
    const taskId = c.req.param('id');
    const [prerequisites, dependents, blockers] = await Promise.all([
      dependencyService.getPrerequisites(prisma, taskId),
      dependencyService.getDependents(prisma, taskId),
      dependencyService.getBlockers(prisma, taskId),
    ]);
    return c.json({
      prerequisites: prerequisites.map((p) => ({ ...p, dependsOnTask: p.dependsOnTask })),
      dependents,
      blockers,
    });
  })

  .post('/:id/dependencies', async (c) => {
    const taskId = c.req.param('id');
    const body = parseOrThrow(z.object({ dependsOnTaskId: uuid }), await c.req.json());

    const resource = await taskService.loadTaskResource(prisma, taskId);
    assertCan(actorOf(c), 'task:manageDependencies', resource);

    await prisma.$transaction(async (tx) => {
      await dependencyService.addDependency(tx, {
        taskId,
        dependsOnTaskId: body.dependsOnTaskId,
        userId: actorOf(c).id,
      });
      // Adding a blocker may immediately block the dependent.
      await dependencyService.reconcileSubgraph(tx, taskId, { userId: actorOf(c).id });
    });

    return c.json({ message: 'Dependency added' }, 201);
  })

  .delete('/:id/dependencies/:dependencyId', async (c) => {
    const taskId = c.req.param('id');
    const resource = await taskService.loadTaskResource(prisma, taskId);
    assertCan(actorOf(c), 'task:manageDependencies', resource);

    await prisma.$transaction(async (tx) => {
      await dependencyService.removeDependency(tx, {
        taskId,
        dependencyId: c.req.param('dependencyId'),
        userId: actorOf(c).id,
      });
      await dependencyService.reconcileSubgraph(tx, taskId, { userId: actorOf(c).id });
    });

    return c.json({ message: 'Dependency removed' });
  })

  .get('/:id/comments', async (c) => {
    const taskId = c.req.param('id');
    const resource = await taskService.loadTaskResource(prisma, taskId);
    const actor = actorOf(c);
    const isGuest = actor.role === 'CLIENT_GUEST';

    if (isGuest) {
      // Belt and braces on top of the mapper: the query itself excludes
      // internal threads rather than filtering them out afterwards.
      if (!resource.isClientVisible || resource.projectClientOrgId !== actor.clientOrgId) {
        throw AppError.notFound('Task', taskId);
      }
    }

    const comments = await prisma.comment.findMany({
      where: { taskId, ...(isGuest ? { isInternal: false } : {}) },
      orderBy: { createdAt: 'asc' },
      include: {
        author: { select: { id: true, name: true, email: true, avatarUrl: true, department: true, role: true } },
      },
    });

    return c.json({
      data: isGuest
        ? comments.map((row) => ({
            id: row.id,
            body: row.body,
            createdAt: row.createdAt,
            isFromClient: row.author.role === 'CLIENT_GUEST',
          }))
        : comments.map((row) => toFullComment(row as any)),
    });
  })

  .post('/:id/comments', rateLimit({ windowMs: 60_000, max: 30 }), async (c) => {
    const taskId = c.req.param('id');
    const body = parseOrThrow(
      z.object({ body: safeText(2000), isInternal: z.boolean().default(true) }),
      await c.req.json(),
    );

    const resource = await taskService.loadTaskResource(prisma, taskId);
    const actor = actorOf(c);
    assertCan(actor, 'comment:create', resource);

    const comment = await prisma.$transaction(async (tx) => {
      const created = await tx.comment.create({
        data: { taskId, authorId: actor.id, body: body.body, isInternal: body.isInternal },
      });
      await writeLog(tx, {
        taskId,
        projectId: resource.projectId,
        userId: actor.id,
        action: 'COMMENT_ADDED',
        column: 'comment',
        newValue: body.isInternal ? '[internal comment]' : '[shared comment]',
        metadata: { commentId: created.id },
      });
      return created;
    });

    return c.json(
      {
        id: comment.id,
        taskId,
        body: comment.body,
        isInternal: comment.isInternal,
        createdAt: comment.createdAt,
        author: {
          id: actor.id,
          name: actor.name,
          email: actor.email,
          avatarUrl: actor.avatarUrl,
          role: actor.role,
          department: actor.department,
        },
      },
      201,
    );
  })

  /**
   * Attachment upload. Internal team members may upload — the brief gives them
   * exactly this alongside status changes — while a CLIENT_GUEST may not.
   */
  .post('/:id/attachments', rateLimit({ windowMs: 60_000, max: 20 }), async (c) => {
    const taskId = c.req.param('id');
    const resource = await taskService.loadTaskResource(prisma, taskId);
    const actor = actorOf(c);
    assertCan(actor, 'attachment:upload', resource);

    const form = await c.req.formData().catch(() => {
      throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Expected multipart/form-data with a "file" field');
    });

    const file = form.get('file');
    if (!(file instanceof File)) {
      throw new AppError('VALIDATION_ERROR', 'A file field is required');
    }

    const maxBytes = (env.MAX_UPLOAD_SIZE_MB ?? 10) * 1024 * 1024;
    if (file.size > maxBytes) {
      throw new AppError('PAYLOAD_TOO_LARGE', `File exceeds the ${env.MAX_UPLOAD_SIZE_MB}MB limit`, {
        size: file.size,
        maxBytes,
      });
    }

    const bytes = new Uint8Array(await file.arrayBuffer());

    // The row id doubles as the on-disk name. Generating it up front means the
    // bytes are stored under a name the API controls — never one derived from
    // the caller's `file.name`, which could contain separators or collide — and
    // the download URL stays a permission-checked API route rather than a guess
    // at a static path.
    //
    // The bytes are written *after* the row commits, so a failed insert cannot
    // leave an untracked file behind. The reverse order would leave an orphan on
    // every rolled-back upload, invisible to any cleanup that walks the table.
    const attachmentId = crypto.randomUUID();

    const created = await prisma.$transaction(async (tx) => {
      const created = tx.attachment.create({
        data: {
          id: attachmentId,
          taskId,
          uploadedById: actor.id,
          fileName: file.name,
          fileUrl: `/api/attachments/${attachmentId}`,
          mimeType: file.type || 'application/octet-stream',
          fileSize: file.size,
        },
      });
      await writeLog(tx, {
        taskId,
        projectId: resource.projectId,
        userId: actor.id,
        action: 'ATTACHMENT_ADDED',
        column: 'attachment',
        newValue: file.name,
        metadata: { attachmentId, mimeType: file.type, size: file.size },
      });
      return created;
    });

    // `Bun.write` creates the per-task directory on demand, so a fresh clone
    // needs no `mkdir` step before its first upload.
    await Bun.write(`${env.UPLOAD_DIR ?? './uploads'}/${taskId}/${attachmentId}`, bytes);

    // Re-read with the uploader joined: the insert above has no relation, so
    // mapping it directly would report `uploadedBy: null` on a 201.
    const withUploader = await prisma.attachment.findUniqueOrThrow({
      where: { id: created.id },
      include: {
        uploadedBy: { select: { id: true, name: true, email: true, avatarUrl: true, department: true, role: true } },
      },
    });
    return c.json(toFullAttachment(withUploader as any), 201);
  });

/**
 * Attachment downloads.
 *
 * Files live outside the web root and are streamed through the API rather than
 * served as static content: a static `/uploads/*` route would hand out any
 * task's attachment to anyone who could construct or guess the path, which is
 * authorisation by obscurity. Here the same `canSeeTask` decision that governs
 * reading the task governs reading its files — including the client-visible
 * rule, so a guest cannot fetch a file from a task they cannot see.
 */
export const attachmentRoutes = new Hono<AppEnv>().get('/:id', async (c) => {
  const attachment = await prisma.attachment.findUnique({ where: { id: c.req.param('id') } });
  if (!attachment) throw AppError.notFound('Attachment', c.req.param('id'));

  const resource = await taskService.loadTaskResource(prisma, attachment.taskId);
  if (!canSeeTask(actorOf(c), resource)) {
    throw AppError.notFound('Attachment', attachment.id);
  }

  const path = `${env.UPLOAD_DIR ?? './uploads'}/${attachment.taskId}/${attachment.id}`;
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw AppError.notFound('Attachment file', attachment.fileName);
  }

  // `attachment` rather than `inline`: an uploaded file is work product, and
  // rendering one as HTML would be a stored-XSS surface against the API origin.
  return new Response(file, {
    headers: {
      'content-type': attachment.mimeType,
      'content-disposition': `attachment; filename="${attachment.fileName.replace(/["\\\r\n]/g, '_')}"`,
      'content-length': String(attachment.fileSize),
      'cache-control': 'private, no-store',
    },
  });
});
