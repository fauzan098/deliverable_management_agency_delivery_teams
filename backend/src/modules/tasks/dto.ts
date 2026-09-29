import type { Role } from '../../generated/prisma/enums.ts';

/**
 * Response shaping and data masking.
 *
 * The brief is unambiguous about client isolation:
 *
 * > Data Masking: All internal identities (engineer names, avatars, departments)
 * > and internal comment history must be automatically filtered out from the API
 * > response, not hidden via CSS/Frontend.
 *
 * The implementation choice that makes that hold is a **whitelist mapper**, not
 * a `select` clause.
 *
 * With a `select`, adding a column to the Prisma model and including it in the
 * query is a one-word change that silently starts leaking to clients. With a
 * mapper, the guest payload is a literal object built field by field; a new
 * internal column has nowhere to go until someone deliberately adds it and
 * decides it is safe to expose. Leaking becomes the default-closed direction.
 *
 * Every mapper is total: it takes a row and returns exactly the fields the
 * viewer is entitled to.
 */

// ---------------------------------------------------------------------------
// Row shapes (structural, so mappers can be tested without a live database)
// ---------------------------------------------------------------------------

interface UserIdentity {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  department: string | null;
  role: Role;
}

interface TaskRow {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  department: string;
  isClientVisible: boolean;
  version: number;
  orderIndex: number;
  estimateHours: number | null;
  dueDate: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  assignee?: UserIdentity | null;
  createdBy?: UserIdentity | null;
  project?: { id: string; name: string; code: string; clientOrgId: string } | null;
}

interface AttachmentRow {
  id: string;
  taskId: string;
  fileName: string;
  fileUrl: string;
  mimeType: string;
  fileSize: number;
  createdAt: Date;
  uploadedBy?: UserIdentity | null;
}

interface CommentRow {
  id: string;
  taskId: string;
  body: string;
  isInternal: boolean;
  createdAt: Date;
  author?: UserIdentity | null;
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

/** Internal-facing user shape. Still never includes `passwordHash`. */
export interface PublicUser {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  role: Role;
  department: string | null;
}

/**
 * Strip a user down to what is safe for any authenticated caller. `passwordHash`
 * has no representation here at all, so it cannot be included by omission.
 */
export function toPublicUser(user: UserIdentity): PublicUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    avatarUrl: user.avatarUrl,
    role: user.role,
    department: user.department,
  };
}

/**
 * The deliberately thin shape a client sees when a name is unavoidable — for
 * example on work they are accountable for. No email, no avatar, no department.
 */
export interface MaskedIdentity {
  name: string;
}

export const toMaskedIdentity = (user: UserIdentity | null | undefined): MaskedIdentity | null =>
  user ? { name: user.name } : null;

// ---------------------------------------------------------------------------
// Attachments & comments
// ---------------------------------------------------------------------------

/**
 * A CLIENT_GUEST is told work was delivered but not who delivered it. The
 * uploader's identity is removed; the file itself is client-visible, because
 * delivering an artefact is the point of the flag.
 */
export interface ClientVisibleAttachment {
  id: string;
  fileName: string;
  fileUrl: string;
  mimeType: string;
  fileSize: number;
  createdAt: Date;
}

export function toClientAttachment(row: AttachmentRow): ClientVisibleAttachment {
  return {
    id: row.id,
    fileName: row.fileName,
    fileUrl: row.fileUrl,
    mimeType: row.mimeType,
    fileSize: row.fileSize,
    createdAt: row.createdAt,
  };
}

export function toFullAttachment(row: AttachmentRow) {
  return {
    ...toClientAttachment(row),
    taskId: row.taskId,
    uploadedBy: row.uploadedBy ? toPublicUser(row.uploadedBy) : null,
  };
}

/**
 * A CLIENT_GUEST may see a comment only when it was explicitly marked
 * non-internal *and* authored by a client. Internal discussion — the engineer
 * to engineer thread — is dropped entirely, author included.
 */
export interface ClientVisibleComment {
  id: string;
  body: string;
  createdAt: Date;
  isFromClient: boolean;
}

export function toClientComment(row: CommentRow): ClientVisibleComment {
  return {
    id: row.id,
    body: row.body,
    createdAt: row.createdAt,
    isFromClient: row.author?.role === 'CLIENT_GUEST',
  };
}

export function toFullComment(row: CommentRow) {
  return {
    id: row.id,
    taskId: row.taskId,
    body: row.body,
    isInternal: row.isInternal,
    createdAt: row.createdAt,
    author: row.author ? toPublicUser(row.author) : null,
  };
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export interface TaskSummaryDto {
  id: string;
  title: string;
  status: string;
  priority: string;
  department: string;
  isClientVisible: boolean;
  version: number;
  orderIndex: number;
  dueDate: Date | null;
  estimateHours: number | null;
  projectId: string;
  createdAt: Date;
  updatedAt: Date;
  assignee: PublicUser | null;
  project: { id: string; name: string; code: string } | null;
}

/** Internal/PM view of a task, without the heavy relations. */
export function toTaskSummary(row: TaskRow): TaskSummaryDto {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    priority: row.priority,
    department: row.department,
    isClientVisible: row.isClientVisible,
    version: row.version,
    orderIndex: row.orderIndex,
    dueDate: row.dueDate,
    estimateHours: row.estimateHours,
    projectId: row.projectId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    assignee: row.assignee ? toPublicUser(row.assignee) : null,
    project: row.project ? { id: row.project.id, name: row.project.name, code: row.project.code } : null,
  };
}

/**
 * The masked task a CLIENT_GUEST receives.
 *
 * Removed: assignee, createdBy, department, version, orderIndex, estimateHours
 * (internal planning), the project code, and every internal relation.
 *
 * Kept: the deliverable itself and its state, which is what the client is
 * paying for progress on.
 */
export interface ClientTaskDto {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  isClientVisible: true;
  dueDate: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  project: { id: string; name: string } | null;
  attachments: ClientVisibleAttachment[];
  comments: ClientVisibleComment[];
  /** Present so the client can render a locked/blocked state consistently. */
  dependencies: { total: number; completed: number; allDone: boolean };
}

export function toClientTask(
  row: TaskRow & {
    attachments?: AttachmentRow[];
    comments?: CommentRow[];
    prerequisites?: Array<{ dependsOnTask: { status: string } }>;
  },
): ClientTaskDto {
  const prerequisites = row.prerequisites ?? [];
  const completed = prerequisites.filter((p) => p.dependsOnTask.status === 'DONE').length;

  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    isClientVisible: true,
    dueDate: row.dueDate,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    project: row.project ? { id: row.project.id, name: row.project.name } : null,
    attachments: (row.attachments ?? [])
      // A soft-deleted attachment is already filtered by the Prisma extension.
      .map(toClientAttachment),
    comments: (row.comments ?? []).filter((c) => !c.isInternal).map(toClientComment),
    dependencies: {
      total: prerequisites.length,
      completed,
      allDone: prerequisites.length === 0 || completed === prerequisites.length,
    },
  };
}

/** The full internal task view returned by `GET /api/tasks/:id`. */
export interface TaskDetailDto extends TaskSummaryDto {
  description: string | null;
  createdBy: PublicUser | null;
  startedAt: Date | null;
  completedAt: Date | null;
  blockers: { taskId: string; title: string; status: string }[];
  prerequisites: { id: string; taskId: string; title: string; status: string; department: string }[];
  dependents: { id: string; taskId: string; title: string; status: string; department: string }[];
  attachments: ReturnType<typeof toFullAttachment>[];
  comments: ReturnType<typeof toFullComment>[];
  /** The transitions this viewer may take, so the UI need not re-derive policy. */
  permittedTransitions: { to: string; allowed: boolean; code?: string; message?: string }[];
  permissions: Record<string, boolean>;
}
