import type { ErrorHandler, MiddlewareHandler } from 'hono';
import { env } from '../config/env.ts';
import { AppError, isAppError } from '../lib/errors.ts';
import type { AppEnv } from './auth.ts';

export const requestId = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const id = c.req.header('x-request-id') ?? crypto.randomUUID();
  c.set('requestId', id);
  c.header('x-request-id', id);
  await next();
};

export const logger = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const started = performance.now();
  await next();
  const ms = (performance.now() - started).toFixed(1);
  const actor = c.get('actor');
  const line = `${c.req.method} ${new URL(c.req.url).pathname} -> ${c.res.status} ${ms}ms${
    actor ? ` as=${actor.id}` : ''
  }`;
  if (c.res.status >= 500) console.error(line);
  else if (!env.isTest) console.log(line);
};

/**
 * Turns every thrown value into the same JSON envelope, so the frontend has one
 * error shape to handle.
 *
 * This is registered with `app.onError`, **not** as a `try/catch` middleware.
 * Hono's dispatcher wraps each handler individually and routes a throw straight
 * to `onError`, so an error never propagates up through `await next()` and a
 * wrapping middleware would silently never fire.
 *
 * Prisma's known request errors are translated into the same codes the domain
 * layer uses, rather than leaking driver-specific messages.
 */
export const onError: ErrorHandler<AppEnv> = (err, c) => {
  const requestIdValue = c.get('requestId');

  if (isAppError(err)) {
    return c.json({ error: { ...err.toPayload(), requestId: requestIdValue } }, err.status as never);
  }

  // Prisma unique-constraint violation
  if (isPrismaError(err) && err.code === 'P2002') {
    return c.json(
      {
        error: {
          code: 'CONFLICT',
          message: 'A record with these values already exists',
          requestId: requestIdValue,
        },
      },
      409,
    );
  }

  if (isPrismaError(err) && err.code === 'P2025') {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Record not found', requestId: requestIdValue } }, 404);
  }

  // Our own append-only trigger. Reaching this means a code path tried to
  // mutate history, which is a bug worth surfacing loudly rather than
  // swallowing as a generic 500.
  if (/append-only/i.test(String((err as Error)?.message ?? ''))) {
    console.error(`[${requestIdValue}] AUDIT INTEGRITY: attempted mutation of the append-only log`, err);
  } else {
    console.error(`[${requestIdValue}] Unhandled error:`, err);
  }

  return c.json(
    {
      error: {
        code: 'INTERNAL_ERROR',
        message: env.isProduction ? 'An unexpected error occurred' : String((err as Error)?.message ?? err),
        requestId: requestIdValue,
      },
    },
    500,
  );
};

function isPrismaError(err: unknown): err is { code: string; message: string; meta?: Record<string, unknown> } {
  return (
    typeof err === 'object' && err !== null && 'code' in err && typeof (err as { code: unknown }).code === 'string'
  );
}

/**
 * A minimal fixed-window limiter.
 *
 * In-process and therefore per-instance: adequate for a single-node deployment
 * and honest about its limits. The interface is deliberately narrow so a Redis
 * implementation can drop in behind it without touching any route.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Path parameters that carry a primary key. Everything else is free-form. */
const ID_PARAMS = new Set(['id', 'projectId', 'taskId', 'dependencyId', 'commentId', 'attachmentId']);

/**
 * Rejects malformed UUIDs in the path before a query ever reaches Postgres.
 *
 * Without this, `/api/tasks/nonsense` reaches Prisma, which raises a driver-level
 * "invalid input syntax for type uuid" error and surfaces as a 500 — a client
 * mistake reported as a server fault, with a database message in the payload.
 *
 * The router has already resolved the route by the time this runs, but Hono only
 * populates `c.req.param()` for the *handler*; a wildcard middleware sees an
 * empty map. The matched route pattern does carry the parameter names, so the
 * values are lined up against the request path by position.
 */
export const validateIds = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const routePath = c.req.matchedRoutes.at(-1)?.path;
  if (!routePath) return next();

  const patternSegments = routePath.split('/').filter(Boolean);
  const actualSegments = new URL(c.req.url).pathname.split('/').filter(Boolean);
  if (patternSegments.length !== actualSegments.length) return next();

  for (const [index, segment] of patternSegments.entries()) {
    if (!segment.startsWith(':')) continue;
    const name = segment.slice(1);
    const value = actualSegments[index] ?? '';
    if (ID_PARAMS.has(name) && !UUID_PATTERN.test(value)) {
      throw new AppError('INVALID_ID', `'${name}' must be a valid UUID`, { param: name });
    }
  }

  return next();
};

export const rateLimit = (opts: {
  windowMs: number;
  max: number;
  key?: (c: import('hono').Context) => string;
  /** Paths this limiter does not count, e.g. routine session traffic. */
  skip?: (path: string) => boolean;
}): MiddlewareHandler<AppEnv> => {
  const hits = new Map<string, { count: number; resetAt: number }>();
  const keyFn = opts.key ?? ((c) => c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown');

  return async (c, next) => {
    if (env.isTest) return next();
    if (opts.skip?.(new URL(c.req.url).pathname)) return next();

    const now = Date.now();
    const key = keyFn(c);
    const entry = hits.get(key);

    if (!entry || entry.resetAt < now) {
      hits.set(key, { count: 1, resetAt: now + opts.windowMs });
      return next();
    }

    entry.count += 1;
    if (entry.count > opts.max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      c.header('retry-after', String(retryAfter));
      throw new AppError('RATE_LIMITED', 'Too many requests, please slow down', { retryAfter });
    }

    return next();
  };
};
