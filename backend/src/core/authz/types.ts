import type { Department, ProjectStatus, Role, TaskStatus } from '../../generated/prisma/enums.ts';
import type { ErrorCode } from '../../lib/errors.ts';

// ---------------------------------------------------------------------------
// Actor
// ---------------------------------------------------------------------------

/**
 * The authenticated principal, resolved once per request from the JWT plus a
 * single database lookup.
 *
 * `projectIds` is the read-scope for an INTERNAL_TEAM member: it is the set of
 * projects they have been assigned to, and it is what makes "can only view task
 * details on projects assigned to them" a data-layer constraint rather than a
 * filter the UI applies. It is empty for roles whose scope is org-wide.
 */
export interface Actor {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  role: Role;
  department: Department | null;
  clientOrgId: string | null;
  projectIds: string[];
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

/** A task, carrying exactly the attributes the policy needs to decide. */
export interface TaskResource {
  id: string;
  projectId: string;
  /** The owning project's client organisation — the tenant boundary. */
  projectClientOrgId: string;
  assigneeId: string | null;
  department: Department;
  isClientVisible: boolean;
  status: TaskStatus;
}

export interface ProjectResource {
  id: string;
  clientOrgId: string;
  status: ProjectStatus;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export const ACTIONS = [
  'project:list',
  'project:read',
  'project:create',
  'project:update',
  'project:softDelete',

  'task:list',
  'task:read',
  'task:create',
  /** title, description, priority, department — PM-only per the brief. */
  'task:updateCore',
  /** dueDate, estimateHours, orderIndex — PM or the assignee. */
  'task:updateMeta',
  'task:setClientVisible',
  'task:manageDependencies',
  'task:transition',
  'task:softDelete',
  'task:readLogs',

  'attachment:upload',
  'comment:create',
  'comment:readInternal',

  'member:invite',
  'standup:read',
] as const;

export type Action = (typeof ACTIONS)[number];

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

export type Decision =
  | { allowed: true }
  | {
      allowed: false;
      code: ErrorCode;
      message: string;
      /** Why the decision was made — surfaced to the UI to explain a locked control. */
      reason: string;
    };

export const ALLOW: Decision = { allowed: true };

export const deny = (code: ErrorCode, message: string, reason: string): Decision => ({
  allowed: false,
  code,
  message,
  reason,
});
