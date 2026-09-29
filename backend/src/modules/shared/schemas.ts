import { z } from 'zod';
import { AppError } from '../../lib/errors.ts';

/**
 * Shared validation primitives.
 *
 * Zod schemas are the *entity DTOs* the brief calls for: every request body is
 * parsed into a typed object before it reaches a service, so services never
 * receive `unknown` and cannot be tricked by an unexpected shape.
 */

export const uuid = z.string().uuid('Must be a valid UUID');

export const isoDate = z.coerce.date();

export const pagination = {
  page: z.coerce.number().int().min(1).default(1),
  rows: z.coerce.number().int().min(1).max(100).default(20),
};

export const role = z.enum(['PRODUCT_MANAGER', 'INTERNAL_TEAM', 'CLIENT_GUEST']);
export const department = z.enum(['PRODUCT', 'UI_UX', 'FRONTEND', 'BACKEND']);
export const taskStatus = z.enum(['TODO', 'BLOCKED', 'IN_PROGRESS', 'IN_REVIEW', 'DONE']);
export const priority = z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']);
export const projectStatus = z.enum(['PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETED']);

/**
 * The password policy. Enforced on every path that sets a password (register,
 * invite, change) so a weak credential cannot enter the system by another door.
 */
export const password = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must be at most 128 characters')
  .regex(/[a-z]/, 'Password must contain a lowercase letter')
  .regex(/[A-Z]/, 'Password must contain an uppercase letter')
  .regex(/[0-9]/, 'Password must contain a number');

export const email = z.string().email('Must be a valid email address').max(254);

/** Reject strings that could be used for log injection or XSS through the UI. */
export const safeText = (max: number) => z.string().trim().min(1).max(max);

export const optionalDate = z.coerce.date().nullish();

/**
 * Parse and throw a `VALIDATION_ERROR` AppError rather than Zod's own error, so
 * the API has exactly one error envelope.
 */
export function parseOrThrow<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError('VALIDATION_ERROR', 'Request validation failed', {
      issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return result.data;
}
