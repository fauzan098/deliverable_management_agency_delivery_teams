import { describe, expect, test } from 'bun:test';
import {
  type Blocker,
  canTransition,
  isLegalTransition,
  legalTargetsFrom,
  permittedTransitions,
} from './transition-policy.ts';
import type { Actor, TaskResource } from './types.ts';

/**
 * The state machine and its actor gates are pure functions, which is exactly
 * why they are worth unit-testing: every branch below corresponds to a rule in
 * the brief, and a regression here is a permission bug, not a cosmetic one.
 */

const actor = (over: Partial<Actor> = {}): Actor => ({
  id: 'engineer-1',
  email: 'engineer-1@nodewave.dev',
  name: 'Engineer One',
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
  assigneeId: 'engineer-1',
  department: 'FRONTEND',
  isClientVisible: true,
  status: 'TODO',
  ...over,
});

const blockers = (n: number): Blocker[] =>
  Array.from({ length: n }, (_, i) => ({ taskId: `blocker-${i}`, title: `Blocker ${i}`, status: 'IN_PROGRESS' }));

const decide = (
  a: Actor,
  t: TaskResource,
  from: TaskResource['status'],
  to: TaskResource['status'],
  b: Blocker[] = [],
) => canTransition(a, t, { from, to, blockers: b });

describe('structural state machine', () => {
  test('allows the straight-through executor path TODO -> IN_PROGRESS -> DONE', () => {
    expect(isLegalTransition('TODO', 'IN_PROGRESS')).toBe(true);
    expect(isLegalTransition('IN_PROGRESS', 'DONE')).toBe(true);
  });

  test('allows completion after review, IN_REVIEW -> DONE', () => {
    expect(isLegalTransition('IN_REVIEW', 'DONE')).toBe(true);
  });

  test('rejects a transition that is not an edge at all', () => {
    expect(isLegalTransition('TODO', 'DONE')).toBe(false);
  });

  test('does not allow skipping review backwards out of DONE into BLOCKED', () => {
    expect(isLegalTransition('DONE', 'BLOCKED')).toBe(false);
  });

  test('legalTargetsFrom returns the menu for a status', () => {
    expect(legalTargetsFrom('IN_REVIEW')).toEqual(['IN_PROGRESS', 'DONE']);
  });
});

describe('actor gates', () => {
  test('the assignee may start their own task when nothing blocks it', () => {
    expect(decide(actor(), task(), 'TODO', 'IN_PROGRESS')).toEqual({ allowed: true });
  });

  test('a Product Manager may start work', () => {
    expect(
      decide(actor({ role: 'PRODUCT_MANAGER', department: 'PRODUCT' }), task(), 'TODO', 'IN_PROGRESS').allowed,
    ).toBe(true);
  });

  test('a Product Manager may re-open a Done task', () => {
    expect(
      decide(actor({ role: 'PRODUCT_MANAGER', department: 'PRODUCT' }), task({ status: 'DONE' }), 'DONE', 'IN_PROGRESS')
        .allowed,
    ).toBe(true);
  });

  test('a Product Manager may NOT complete a task, from either completion edge', () => {
    const pm = actor({ role: 'PRODUCT_MANAGER', department: 'PRODUCT' });
    const fromInProgress = decide(pm, task(), 'IN_PROGRESS', 'DONE');
    const fromInReview = decide(pm, task(), 'IN_REVIEW', 'DONE');

    expect(fromInProgress.allowed).toBe(false);
    expect(fromInReview.allowed).toBe(false);
    if (!fromInProgress.allowed) expect(fromInProgress.code).toBe('PM_CANNOT_COMPLETE');
    if (!fromInReview.allowed) expect(fromInReview.code).toBe('PM_CANNOT_COMPLETE');
  });

  test('a non-assignee engineer is refused even for a legal edge', () => {
    const other = actor({ id: 'engineer-2' });
    const decision = decide(other, task(), 'TODO', 'IN_PROGRESS');
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.code).toBe('NOT_ASSIGNEE');
  });

  test('a client guest is refused everywhere', () => {
    const guest = actor({ role: 'CLIENT_GUEST', department: null, clientOrgId: 'org-1' });
    const decision = decide(guest, task(), 'TODO', 'IN_PROGRESS');
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.code).toBe('FORBIDDEN');
  });

  test('an illegal edge is reported as INVALID_TRANSITION before actor rules', () => {
    const decision = decide(actor({ role: 'PRODUCT_MANAGER' }), task(), 'TODO', 'DONE');
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.code).toBe('INVALID_TRANSITION');
  });

  test('a no-op transition is rejected', () => {
    const decision = decide(actor(), task({ status: 'IN_PROGRESS' }), 'IN_PROGRESS', 'IN_PROGRESS');
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.code).toBe('INVALID_TRANSITION');
  });
});

describe('dependency gating', () => {
  test('starting work fails with DEPENDENCY_NOT_MET when a prerequisite is open', () => {
    const decision = decide(actor(), task(), 'TODO', 'IN_PROGRESS', blockers(2));
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.code).toBe('DEPENDENCY_NOT_MET');
  });

  test('the reconciler may lift BLOCKED to TODO even with open prerequisites', () => {
    // The reconciler only ever moves *into* TODO; this asserts the gate is not
    // accidentally applied to that edge and deadlocking the board.
    const decision = decide(actor(), task({ status: 'BLOCKED' }), 'BLOCKED', 'TODO', blockers(1));
    expect(decision.allowed).toBe(true);
  });

  test('a task already in IN_REVIEW is not rewound when a prerequisite reopens', () => {
    const decision = decide(actor(), task({ status: 'IN_REVIEW' }), 'IN_REVIEW', 'IN_PROGRESS', blockers(1));
    expect(decision.allowed).toBe(true);
  });
});

describe('permittedTransitions (the UI menu)', () => {
  test('carries the deny reason so a locked control can explain itself', () => {
    const pm = actor({ role: 'PRODUCT_MANAGER', department: 'PRODUCT' });
    const menu = permittedTransitions(pm, task({ status: 'IN_REVIEW' }), []);

    const toDone = menu.find((t) => t.to === 'DONE');
    expect(toDone).toBeDefined();
    expect(toDone?.allowed).toBe(false);
    expect(toDone?.code).toBe('PM_CANNOT_COMPLETE');
  });

  test('the assignee sees completion as allowed', () => {
    const menu = permittedTransitions(actor(), task({ status: 'IN_REVIEW' }), []);
    expect(menu.find((t) => t.to === 'DONE')?.allowed).toBe(true);
  });
});
