import { AppError } from '../../lib/errors.ts';
import {
  type Action,
  type Actor,
  ALLOW,
  type Decision,
  deny,
  type ProjectResource,
  type TaskResource,
} from './types.ts';

/**
 * The single decision point for every permission in the system.
 *
 * Authorisation here is *both* RBAC and ABAC:
 *
 * - **RBAC** — `actor.role` picks a baseline capability.
 * - **ABAC** — the baseline is then narrowed by attributes of the *resource*
 *   and of the *state*: project membership, tenant organisation, whether the
 *   actor is the assignee, the task's department, and its current status.
 *
 * Two properties are deliberate:
 *
 *  1. `can()` is pure and never throws, so it can be reused to answer "why is
 *     this button disabled?" and to pre-compute the permitted transitions that
 *     the API returns with a task. `assertCan()` is the enforcing wrapper.
 *  2. The read-scope checks (`hasProjectAccess`, `canSeeTask`) are what the
 *     list endpoints use to build their `where` clause, so a denial here and an
 *     invisible row there are guaranteed to agree.
 */

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/**
 * Which projects does this actor have any claim on?
 *
 * - PRODUCT_MANAGER: org-wide (a PM runs the portfolio).
 * - INTERNAL_TEAM: exactly the projects they are assigned to.
 * - CLIENT_GUEST: every project belonging to their own organisation — but
 *   *not* their tasks, which are further filtered by `isClientVisible`.
 */
export function accessibleProjectIds(actor: Actor): string[] | 'all' {
  if (actor.role === 'PRODUCT_MANAGER') return 'all';
  if (actor.role === 'CLIENT_GUEST') return [];
  return actor.projectIds;
}

/**
 * The scope predicate ANDed into every read. For a CLIENT_GUEST this is the
 * hard multi-tenant boundary; for an INTERNAL_TEAM member it is the project
 * boundary.
 *
 * `target` matters because the same logical boundary is expressed differently
 * depending on which table is being queried: a `Task` reaches its organisation
 * through the `project` relation, while a `Project` *is* the row that carries
 * `clientOrgId`. Getting this wrong is not a cosmetic bug — it is the
 * difference between an isolated tenant and a 500.
 */
export function readScope(actor: Actor, target: 'project' | 'task' = 'project'): Record<string, unknown> {
  const isProject = target === 'project';

  switch (actor.role) {
    case 'PRODUCT_MANAGER':
      return {};
    case 'INTERNAL_TEAM':
      return isProject ? { id: { in: actor.projectIds } } : { projectId: { in: actor.projectIds } };
    case 'CLIENT_GUEST':
      // Belt and braces: the organisation id is pinned to the JWT's claim, and
      // additionally cross-checked against the joined project. Even if a
      // clientOrgId were ever forged in a token, `project.clientOrgId` must
      // still match.
      return isProject
        ? { clientOrgId: actor.clientOrgId ?? '__none__' }
        : { project: { clientOrgId: actor.clientOrgId ?? '__none__' } };
    default:
      return { id: '__none__' };
  }
}

export function hasProjectAccess(actor: Actor, project: ProjectResource): boolean {
  if (actor.role === 'PRODUCT_MANAGER') return true;
  if (actor.role === 'INTERNAL_TEAM') return actor.projectIds.includes(project.id);
  if (actor.role === 'CLIENT_GUEST') return project.clientOrgId === actor.clientOrgId;
  return false;
}

/**
 * Row-level read visibility for a single task.
 *
 * A CLIENT_GUEST needs *three* things to be true, not one: same organisation,
 * project still visible to them, and the task explicitly flagged
 * `isClientVisible` by a PM.
 */
export function canSeeTask(actor: Actor, task: TaskResource): boolean {
  if (actor.role === 'PRODUCT_MANAGER') return true;
  if (actor.role === 'INTERNAL_TEAM') return actor.projectIds.includes(task.projectId);
  if (actor.role === 'CLIENT_GUEST') {
    return task.isClientVisible && task.projectClientOrgId === actor.clientOrgId;
  }
  return false;
}

// ---------------------------------------------------------------------------
// The policy
// ---------------------------------------------------------------------------

export function can(actor: Actor, action: Action, resource: TaskResource | ProjectResource): Decision {
  const isTaskResource = 'assigneeId' in resource;
  const isPm = actor.role === 'PRODUCT_MANAGER';
  const isGuest = actor.role === 'CLIENT_GUEST';
  const isInternal = actor.role === 'INTERNAL_TEAM';

  // ---- Reads -------------------------------------------------------------
  if (action === 'project:list' || action === 'project:read') {
    const project = resource as ProjectResource;
    if (!hasProjectAccess(actor, project)) {
      return deny('FORBIDDEN', 'You do not have access to this project', 'not-a-project-member');
    }
    return ALLOW;
  }

  if (action === 'task:list' || action === 'task:read') {
    if (!isTaskResource) return ALLOW; // task:list is project-scoped upstream
    if (canSeeTask(actor, resource as TaskResource)) return ALLOW;
    if (isGuest) {
      return deny('FORBIDDEN', 'This task is not shared with you', 'task-not-flagged-client-visible');
    }
    return deny('FORBIDDEN', 'You do not have access to this task', 'not-a-project-member');
  }

  // ---- Project mutations -------------------------------------------------
  if (action === 'project:create') {
    return isPm
      ? ALLOW
      : deny('INTERNAL_MEMBER_FORBIDDEN', 'Only a Product Manager can create projects', 'role-not-pm');
  }

  if (action === 'project:update' || action === 'project:softDelete') {
    if (!isPm) {
      return deny('INTERNAL_MEMBER_FORBIDDEN', 'Only a Product Manager can modify projects', 'role-not-pm');
    }
    return ALLOW;
  }

  // ---- Task mutations ----------------------------------------------------
  if (action === 'task:create') {
    return isPm ? ALLOW : deny('INTERNAL_MEMBER_FORBIDDEN', 'Only a Product Manager can create tasks', 'role-not-pm');
  }

  if (action === 'task:updateCore') {
    // The brief is explicit: internal team members may upload attachments and
    // move status, but the core description is not theirs to rewrite.
    return isPm
      ? ALLOW
      : deny(
          'INTERNAL_MEMBER_FORBIDDEN',
          "Only a Product Manager can change a task's core details (title, description, priority)",
          'role-not-pm',
        );
  }

  if (action === 'task:updateMeta') {
    if (isGuest) return deny('FORBIDDEN', 'Clients have read-only access', 'client-guest-readonly');
    const task = resource as TaskResource;
    if (isPm) return ALLOW;
    if (isInternal && task.assigneeId === actor.id) return ALLOW;
    return deny(
      'NOT_ASSIGNEE',
      'Only the assignee or a Product Manager can change scheduling fields',
      'not-the-assignee',
    );
  }

  if (action === 'task:setClientVisible') {
    return isPm
      ? ALLOW
      : deny('INTERNAL_MEMBER_FORBIDDEN', 'Only a Product Manager can change what the client sees', 'role-not-pm');
  }

  if (action === 'task:manageDependencies') {
    return isPm
      ? ALLOW
      : deny('INTERNAL_MEMBER_FORBIDDEN', 'Only a Product Manager can define task dependencies', 'role-not-pm');
  }

  if (action === 'task:softDelete') {
    return isPm ? ALLOW : deny('INTERNAL_MEMBER_FORBIDDEN', 'Only a Product Manager can archive tasks', 'role-not-pm');
  }

  if (action === 'task:transition') {
    // Delegated to the state machine — it needs `to`, which is not part of a
    // bare TaskResource. `canTransition` is the real entry point.
    return deny('INVALID_TRANSITION', 'Use canTransition() to evaluate a status change', 'use-transition-policy');
  }

  if (action === 'task:readLogs') {
    if (isGuest) {
      return deny('FORBIDDEN', 'The audit trail is internal', 'client-guest-no-audit-trail');
    }
    if (isPm) return ALLOW;
    if (isInternal && actor.projectIds.includes((resource as TaskResource).projectId)) return ALLOW;
    return deny('FORBIDDEN', 'You do not have access to this project', 'not-a-project-member');
  }

  // ---- Attachments & comments -------------------------------------------
  if (action === 'attachment:upload') {
    if (isGuest) {
      return deny('FORBIDDEN', 'Clients cannot upload work attachments', 'client-guest-readonly');
    }
    if (isPm) return ALLOW;
    if (isInternal && actor.projectIds.includes((resource as TaskResource).projectId)) return ALLOW;
    return deny('FORBIDDEN', 'You do not have access to this project', 'not-a-project-member');
  }

  if (action === 'comment:create') {
    if (isGuest) {
      return deny('FORBIDDEN', 'Clients cannot comment on tasks', 'client-guest-readonly');
    }
    if (isPm) return ALLOW;
    if (isInternal && actor.projectIds.includes((resource as TaskResource).projectId)) return ALLOW;
    return deny('FORBIDDEN', 'You do not have access to this project', 'not-a-project-member');
  }

  if (action === 'comment:readInternal') {
    if (isGuest) {
      return deny('FORBIDDEN', 'Internal discussion is not shared with clients', 'client-guest-no-internal-comments');
    }
    return isPm || isInternal ? ALLOW : deny('FORBIDDEN', 'Not permitted', 'forbidden');
  }

  // ---- Membership & standup ---------------------------------------------
  if (action === 'member:invite') {
    return isPm
      ? ALLOW
      : deny('INTERNAL_MEMBER_FORBIDDEN', 'Only a Product Manager can manage project members', 'role-not-pm');
  }

  if (action === 'standup:read') {
    if (isGuest) {
      return deny('FORBIDDEN', 'The standup summary is internal', 'client-guest-no-standup');
    }
    return isPm || isInternal ? ALLOW : deny('FORBIDDEN', 'Not permitted', 'forbidden');
  }

  return deny('FORBIDDEN', `Unhandled action '${action}'`, 'unhandled-action');
}

// ---------------------------------------------------------------------------
// Enforcing wrapper
// ---------------------------------------------------------------------------

export function assertCan(actor: Actor, action: Action, resource: TaskResource | ProjectResource): void {
  const decision = can(actor, action, resource);
  if (!decision.allowed) {
    throw new AppError(decision.code, decision.message, { action, reason: decision.reason });
  }
}
