/**
 * Application error taxonomy.
 *
 * Every failure the API can produce has a stable machine-readable `code` so the
 * frontend can react (e.g. `VERSION_CONFLICT` -> refetch and toast) without
 * string-matching on human-readable messages, which are free to change and are
 * not localised.
 */

export type ErrorCode =
  // 400 / 422 — request shape and state
  | 'INVALID_ID'
  | 'VALIDATION_ERROR'
  | 'DEPENDENCY_NOT_MET'
  | 'CYCLE_DETECTED'
  | 'INVALID_TRANSITION'
  | 'SELF_DEPENDENCY'
  | 'CROSS_PROJECT_DEPENDENCY'
  | 'DUPLICATE_DEPENDENCY'
  // 401 / 403 — identity and authorisation
  | 'UNAUTHORIZED'
  | 'TOKEN_EXPIRED'
  | 'INVALID_CREDENTIALS'
  | 'FORBIDDEN'
  | 'PM_CANNOT_COMPLETE'
  | 'NOT_ASSIGNEE'
  | 'INTERNAL_MEMBER_FORBIDDEN'
  | 'EMAIL_ALREADY_REGISTERED'
  | 'ROLE_NOT_SELF_REGISTERABLE'
  // 404
  | 'NOT_FOUND'
  // 409 — concurrency and uniqueness
  | 'VERSION_CONFLICT'
  | 'CONFLICT'
  // 413 / 415 / 422 — uploads
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  // 429
  | 'RATE_LIMITED'
  // 500
  | 'INTERNAL_ERROR';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  INVALID_ID: 400,
  VALIDATION_ERROR: 422,
  DEPENDENCY_NOT_MET: 422,
  CYCLE_DETECTED: 422,
  INVALID_TRANSITION: 422,
  SELF_DEPENDENCY: 422,
  CROSS_PROJECT_DEPENDENCY: 422,
  DUPLICATE_DEPENDENCY: 409,

  UNAUTHORIZED: 401,
  TOKEN_EXPIRED: 401,
  INVALID_CREDENTIALS: 401,
  FORBIDDEN: 403,
  PM_CANNOT_COMPLETE: 403,
  NOT_ASSIGNEE: 403,
  INTERNAL_MEMBER_FORBIDDEN: 403,
  EMAIL_ALREADY_REGISTERED: 409,
  ROLE_NOT_SELF_REGISTERABLE: 403,

  NOT_FOUND: 404,

  VERSION_CONFLICT: 409,
  CONFLICT: 409,

  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,

  RATE_LIMITED: 429,

  INTERNAL_ERROR: 500,
};

export interface AppErrorPayload {
  code: ErrorCode;
  message: string;
  /** Structured detail used by the UI to explain *why* a control is locked. */
  details?: Record<string, unknown>;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    if (details) this.details = details;
  }

  toPayload(): AppErrorPayload {
    return {
      code: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
    };
  }

  static unauthorized(message = 'Authentication required'): AppError {
    return new AppError('UNAUTHORIZED', message);
  }

  static forbidden(
    message = 'You do not have permission to perform this action',
    details?: Record<string, unknown>,
  ): AppError {
    return new AppError('FORBIDDEN', message, details);
  }

  static notFound(resource: string, id?: string): AppError {
    return new AppError('NOT_FOUND', id ? `${resource} '${id}' was not found` : `${resource} was not found`, {
      resource,
      ...(id ? { id } : {}),
    });
  }

  /**
   * Thrown when an `updateMany` guarded by `where: { id, version }` matches no
   * rows — i.e. a concurrent writer already advanced the version. The caller
   * passes the server's current state so the client can reconcile instead of
   * guessing.
   */
  static versionConflict(current: Record<string, unknown>, details?: Record<string, unknown>): AppError {
    return new AppError(
      'VERSION_CONFLICT',
      'This task was modified by someone else while you were editing it. Reload to see the latest state.',
      { current, ...details },
    );
  }
}

export const isAppError = (err: unknown): err is AppError => err instanceof AppError;
