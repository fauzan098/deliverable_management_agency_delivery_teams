import { assertCan, hasProjectAccess, readScope } from '../../core/authz/authorize.ts';
import type { Actor } from '../../core/authz/types.ts';
import { AppError } from '../../lib/errors.ts';
import { prisma } from '../../lib/prisma.ts';
import { type ListResult, runQuery } from '../../lib/query.ts';
import { getProjectMetrics } from '../tasks/task.service.ts';

/**
 * Projects and membership.
 *
 * Membership is the hinge of the INTERNAL_TEAM read boundary: a member sees
 * tasks in the projects they are assigned to and nothing else, and CLIENT_GUEST
 * provisioning happens here because it is a project-scoped act by a PM.
 */

export interface ProjectDto {
  id: string;
  name: string;
  code: string;
  description: string | null;
  status: string;
  clientOrgId: string;
  version: number;
  startDate: Date | null;
  dueDate: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /** Present for internal roles; a guest learns the org exists, nothing more. */
  clientOrg?: { id: string; name: string } | null;
  taskCount?: number;
  isMember?: boolean;
}

const projectInclude = {
  clientOrg: { select: { id: true, name: true, slug: true } },
  _count: { select: { tasks: true, members: true } },
} as const;

export async function listProjects(
  actor: Actor,
  params: Record<string, string | string[] | undefined>,
): Promise<ListResult<ProjectDto>> {
  const scope = readScope(actor);

  return runQuery<ProjectDto, any>({
    params,
    delegate: prisma.project,
    spec: {
      allowedFields: ['id', 'name', 'code', 'status', 'clientOrgId', 'startDate', 'dueDate', 'createdAt', 'updatedAt'],
      allowedRelations: ['clientOrg'],
      forbiddenFields: [],
    },
    // For a CLIENT_GUEST this is the tenant boundary: their own organisation
    // and nothing beyond it.
    scope,
    stableOrderBy: { createdAt: 'desc' },
    include: projectInclude,
    transform: (rows) =>
      (rows as any[]).map((row) => ({
        id: row.id,
        name: row.name,
        code: row.code,
        description: row.description,
        status: row.status,
        clientOrgId: row.clientOrgId,
        version: row.version,
        startDate: row.startDate,
        dueDate: row.dueDate,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        clientOrg: actor.role === 'CLIENT_GUEST' ? null : row.clientOrg,
        taskCount: row._count?.tasks,
        isMember: actor.role === 'INTERNAL_TEAM' ? actor.projectIds.includes(row.id) : true,
      })),
  });
}

export async function getProject(
  actor: Actor,
  projectId: string,
): Promise<ProjectDto & { metrics: Awaited<ReturnType<typeof getProjectMetrics>> }> {
  const project = await prisma.project.findUnique({ where: { id: projectId }, include: projectInclude });
  if (!project) throw AppError.notFound('Project', projectId);

  /**
   * A guest asking for another tenant's project gets 404, not 403: 403 would
   * confirm the project exists, letting a tenant enumerate a competitor's
   * portfolio one id at a time. The task-list endpoint already answers 404 for
   * the same reason; this keeps the surface consistent.
   */
  if (actor.role === 'CLIENT_GUEST' && project.clientOrgId !== actor.clientOrgId) {
    throw AppError.notFound('Project', projectId);
  }

  assertCan(actor, 'project:read', { id: project.id, clientOrgId: project.clientOrgId, status: project.status });

  return {
    id: project.id,
    name: project.name,
    code: project.code,
    description: project.description,
    status: project.status,
    clientOrgId: project.clientOrgId,
    version: project.version,
    startDate: project.startDate,
    dueDate: project.dueDate,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    clientOrg: actor.role === 'CLIENT_GUEST' ? null : project.clientOrg,
    taskCount: project._count.tasks,
    isMember: actor.role === 'INTERNAL_TEAM' ? actor.projectIds.includes(project.id) : true,
    metrics: await getProjectMetrics(actor, projectId),
  };
}

export interface CreateProjectInput {
  name: string;
  code: string;
  description?: string | null;
  clientOrgId: string;
  startDate?: Date | null;
  dueDate?: Date | null;
  status?: 'PLANNING' | 'ACTIVE' | 'ON_HOLD' | 'COMPLETED';
}

export async function createProject(actor: Actor, input: CreateProjectInput): Promise<ProjectDto> {
  if (actor.role !== 'PRODUCT_MANAGER') {
    throw new AppError('INTERNAL_MEMBER_FORBIDDEN', 'Only a Product Manager can create projects');
  }

  const org = await prisma.clientOrganization.findUnique({ where: { id: input.clientOrgId }, select: { id: true } });
  if (!org) throw AppError.notFound('Client organisation', input.clientOrgId);

  const project = await prisma.project.create({
    data: {
      name: input.name,
      code: input.code.toUpperCase(),
      description: input.description ?? null,
      clientOrgId: input.clientOrgId,
      startDate: input.startDate ?? null,
      dueDate: input.dueDate ?? null,
      status: input.status ?? 'PLANNING',
    },
    include: projectInclude,
  });

  return toDto(project);
}

export async function updateProject(
  actor: Actor,
  input: {
    id: string;
    version: number;
    name?: string;
    description?: string | null;
    status?: string;
    dueDate?: Date | null;
    startDate?: Date | null;
  },
): Promise<ProjectDto> {
  const project = await prisma.project.findUnique({
    where: { id: input.id },
    select: { id: true, clientOrgId: true, status: true },
  });
  if (!project) throw AppError.notFound('Project', input.id);

  assertCan(actor, 'project:update', { id: project.id, clientOrgId: project.clientOrgId, status: project.status });

  const data: Record<string, unknown> = {};
  for (const key of ['name', 'description', 'status', 'dueDate', 'startDate'] as const) {
    if (input[key] !== undefined) data[key] = input[key];
  }
  if (Object.keys(data).length === 0) throw new AppError('VALIDATION_ERROR', 'No updatable fields were provided');

  const updated = await prisma.project.updateMany({
    where: { id: input.id, version: input.version },
    data: { ...data, version: { increment: 1 } },
  });

  if (updated.count === 0) {
    const current = await prisma.project.findUnique({
      where: { id: input.id },
      select: { id: true, version: true, updatedAt: true },
    });
    throw AppError.versionConflict({ id: current?.id, version: current?.version, updatedAt: current?.updatedAt });
  }

  const fresh = await prisma.project.findUnique({ where: { id: input.id }, include: projectInclude });
  return toDto(fresh!);
}

const toDto = (row: any): ProjectDto => ({
  id: row.id,
  name: row.name,
  code: row.code,
  description: row.description,
  status: row.status,
  clientOrgId: row.clientOrgId,
  version: row.version,
  startDate: row.startDate,
  dueDate: row.dueDate,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  clientOrg: row.clientOrg ?? null,
  taskCount: row._count?.tasks,
});

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

export interface MemberDto {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  role: string;
  department: string | null;
}

export async function listMembers(actor: Actor, projectId: string): Promise<MemberDto[]> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, clientOrgId: true, status: true },
  });
  if (!project) throw AppError.notFound('Project', projectId);
  assertCan(actor, 'project:read', project);

  // A guest sees the internal team as anonymous: names only, no email, avatar
  // or department. This is the same masking rule as on tasks, applied at the
  // membership listing so there is no un-masked back door.
  const members = await prisma.projectMember.findMany({
    where: { projectId, deletedAt: null },
    orderBy: { createdAt: 'asc' },
    include: { user: { select: { id: true, name: true, email: true, avatarUrl: true, role: true, department: true } } },
  });

  if (actor.role === 'CLIENT_GUEST') {
    return members
      .filter((m) => m.user.role !== 'CLIENT_GUEST')
      .map((m) => ({
        id: m.user.id,
        name: m.user.name,
        email: '',
        avatarUrl: null,
        role: m.user.role,
        department: null,
      }));
  }

  return members.map((m) => ({
    id: m.user.id,
    name: m.user.name,
    email: m.user.email,
    avatarUrl: m.user.avatarUrl,
    role: m.user.role,
    department: m.user.department,
  }));
}

export interface InviteMemberInput {
  projectId: string;
  name: string;
  email: string;
  password: string;
  /** Required only when the member is a CLIENT_GUEST. */
  department?: 'UI_UX' | 'FRONTEND' | 'BACKEND' | 'PRODUCT' | null;
  role: 'INTERNAL_TEAM' | 'CLIENT_GUEST';
}

export async function inviteMember(
  actor: Actor,
  input: InviteMemberInput,
): Promise<{ user: MemberDto; memberId: string }> {
  const project = await prisma.project.findUnique({
    where: { id: input.projectId },
    select: { id: true, clientOrgId: true, status: true },
  });
  if (!project) throw AppError.notFound('Project', input.projectId);
  assertCan(actor, 'member:invite', project);

  const email = input.email.toLowerCase().trim();

  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true, deletedAt: true } });
  if (existing && !existing.deletedAt) {
    throw new AppError('EMAIL_ALREADY_REGISTERED', 'An account with this email already exists', { email });
  }

  /**
   * A CLIENT_GUEST is pinned to the project's own organisation. It is not
   * possible to invite a guest into another tenant's project, which is what
   * makes the isolation provable rather than merely intended.
   */
  if (input.role === 'CLIENT_GUEST' && input.department) {
    throw new AppError('VALIDATION_ERROR', 'A client guest cannot belong to an internal department');
  }

  const { hashPassword } = await import('../../lib/password.ts');
  const user = await prisma.user.create({
    data: {
      email,
      name: input.name,
      passwordHash: await hashPassword(input.password),
      role: input.role,
      department: input.role === 'CLIENT_GUEST' ? null : (input.department ?? 'FRONTEND'),
      clientOrgId: input.role === 'CLIENT_GUEST' ? project.clientOrgId : null,
      isActive: true,
    },
  });

  const member = await prisma.projectMember.create({
    data: { projectId: project.id, userId: user.id },
  });

  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      avatarUrl: user.avatarUrl,
      role: user.role,
      department: user.department,
    },
    memberId: member.id,
  };
}

/**
 * Client organisations, for the project-creation form.
 *
 * A guest sees only their own organisation (the same tenant boundary as every
 * other read); internal roles see the full list so a PM can start a project for
 * any client.
 */
export async function listClientOrgs(actor: Actor): Promise<{ id: string; name: string; slug: string }[]> {
  const select = { id: true, name: true, slug: true } as const;

  if (actor.role === 'CLIENT_GUEST') {
    if (!actor.clientOrgId) return [];
    const org = await prisma.clientOrganization.findUnique({ where: { id: actor.clientOrgId }, select });
    return org ? [org] : [];
  }

  return prisma.clientOrganization.findMany({ orderBy: { name: 'asc' }, select });
}

export { hasProjectAccess };
