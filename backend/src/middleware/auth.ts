import type { MiddlewareHandler } from 'hono';
import type { Actor } from '../core/authz/types.ts';
import { AppError } from '../lib/errors.ts';
import { TokenError, tokens } from '../lib/jwt.ts';
import { resolveActor } from '../modules/auth/auth.service.ts';

/**
 * Authentication middleware.
 *
 * Accepts the access token from either an `Authorization: Bearer` header or an
 * httpOnly cookie. The cookie is what lets the Next.js middleware make
 * server-side route decisions without exposing the token to JavaScript; the
 * header keeps the API usable by any other client (curl, mobile, the tests).
 */

export type AppEnv = {
  Variables: {
    actor: Actor;
    requestId: string;
  };
};

/** Routes that are reachable without a session. */
const PUBLIC_PATHS = new Set(['/health', '/api/health', '/api/auth/login', '/api/auth/register', '/api/auth/refresh']);

export function extractToken(header: string | undefined, cookie: string | undefined): string | null {
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  if (cookie) {
    const match = /(?:^|;\s*)nw_access=([^;]+)/.exec(cookie);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return null;
}

export const requireAuth = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (PUBLIC_PATHS.has(path)) return next();

  const token = extractToken(c.req.header('authorization'), c.req.header('cookie'));

  if (!token) {
    throw new AppError('UNAUTHORIZED', 'Authentication required');
  }

  let claims: ReturnType<typeof tokens.verifyAccess>;
  try {
    claims = tokens.verifyAccess(token);
  } catch (err) {
    if (err instanceof TokenError && err.expired) {
      throw new AppError('TOKEN_EXPIRED', 'Access token has expired');
    }
    throw new AppError('UNAUTHORIZED', 'Invalid access token');
  }

  c.set('actor', await resolveActor(claims));
  return next();
};
