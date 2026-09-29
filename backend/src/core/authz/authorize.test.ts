import { describe, expect, test } from 'bun:test';
import { can, canSeeTask, hasProjectAccess, readScope } from './authorize.ts';
import type { Actor, ProjectResource, TaskResource } from './types.ts';

const actor = (over: Partial<Actor> = {}): Actor => ({
  id: 'internal-1',
  email: 'internal-1@nodewave.dev',
  name: 'Internal One',
  avatarUrl: null,
  role: 'INTERNAL_TEAM',
  department: 'FRONTEND',
  clientOrgId: null,
  projectIds: ['project-1'],
  ...over,
});

const task = (over: Partial<TaskResource> = {}): TaskResource => ({
  id: 'task-1',
  projectId: 'project-1',
  projectClientOrgId: 'org-1',
  assigneeId: 'internal-1',
  department: 'FRONTEND',
  isClientVisible: true,
  status: 'IN_PROGRESS',
  ...over,
});

const project = (over: Partial<ProjectResource> = {}): ProjectResource => ({
  id: 'project-1',
  clientOrgId: 'org-1',
  status: 'ACTIVE',
  ...over,
});

describe('readScope is table-aware', () => {
  test('a guest is scoped by clientOrgId on the project table', () => {
    const guest = actor({ role: 'CLIENT_GUEST', department: null, clientOrgId: 'org-1' });
    expect(readScope(guest, 'project')).toEqual({ clientOrgId: 'org-1' });
  });

  test('a guest is scoped through the project relation on the task table', () => {
    const guest = actor({ role: 'CLIENT_GUEST', department: null, clientOrgId: 'org-1' });
    expect(readScope(guest, 'task')).toEqual({ project: { clientOrgId: 'org-1' } });
  });

  test('an internal member is scoped by id on projects and projectId on tasks', () => {
    const member = actor({ projectIds: ['project-1', 'project-2'] });
    expect(readScope(member, 'project')).toEqual({ id: { in: ['project-1', 'project-2'] } });
    expect(readScope(member, 'task')).toEqual({ projectId: { in: ['project-1', 'project-2'] } });
  });

  test('a product manager is unscoped', () => {
    expect(readScope(actor({ role: 'PRODUCT_MANAGER', department: 'PRODUCT' }), 'project')).toEqual({});
  });

  test('a guest with no organisation can match nothing', () => {
    const guest = actor({ role: 'CLIENT_GUEST', department: null, clientOrgId: null });
    expect(readScope(guest, 'project')).toEqual({ clientOrgId: '__none__' });
  });
});

describe('read visibility', () => {
  test('a guest sees a task only when it is client-visible and in their tenant', () => {
    const guest = actor({ role: 'CLIENT_GUEST', department: null, clientOrgId: 'org-1' });
    expect(canSeeTask(guest, task({ isClientVisible: true }))).toBe(true);
    expect(canSeeTask(guest, task({ isClientVisible: false }))).toBe(false);
    expect(canSeeTask(guest, task({ projectClientOrgId: 'org-2' }))).toBe(false);
  });

  test('an internal member sees tasks in their projects only', () => {
    const member = actor({ projectIds: ['project-1'] });
    expect(canSeeTask(member, task({ projectId: 'project-1' }))).toBe(true);
    expect(canSeeTask(member, task({ projectId: 'project-2' }))).toBe(false);
  });

  test('hasProjectAccess agrees with the scope for a non-member', () => {
    const member = actor({ projectIds: ['project-1'] });
    expect(hasProjectAccess(member, project({ id: 'project-2' }))).toBe(false);
    expect(can(member, 'project:read', project({ id: 'project-2' })).allowed).toBe(false);
  });
});

describe('core edit boundary', () => {
  test('an engineer may not rewrite core task details', () => {
    const decision = can(actor(), 'task:updateCore', task());
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.code).toBe('INTERNAL_MEMBER_FORBIDDEN');
  });

  test('a product manager may', () => {
    expect(can(actor({ role: 'PRODUCT_MANAGER', department: 'PRODUCT' }), 'task:updateCore', task()).allowed).toBe(
      true,
    );
  });
});

describe('scheduling metadata boundary', () => {
  test('the assignee may change scheduling fields', () => {
    expect(can(actor(), 'task:updateMeta', task({ assigneeId: 'internal-1' })).allowed).toBe(true);
  });

  test('a non-assignee engineer may not', () => {
    const decision = can(actor({ id: 'internal-2' }), 'task:updateMeta', task({ assigneeId: 'internal-1' }));
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.code).toBe('NOT_ASSIGNEE');
  });

  test('a guest is read-only', () => {
    const guest = actor({ role: 'CLIENT_GUEST', department: null, clientOrgId: 'org-1' });
    const decision = can(guest, 'task:updateMeta', task());
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.code).toBe('FORBIDDEN');
  });
});
