import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { env } from '../../config/env.ts';
import { AppError } from '../../lib/errors.ts';
import type { AppEnv } from '../../middleware/auth.ts';
import { department, email as emailSchema, parseOrThrow, password, safeText } from '../shared/schemas.ts';
import * as authService from './auth.service.ts';

const COOKIE_ACCESS = 'nw_access';
const COOKIE_REFRESH = 'nw_refresh';

const setAuthCookies = (c: any, session: authService.AuthSession) => {
  const isProd = env.isProduction;
  /**
   * The access token is in an httpOnly cookie so that XSS cannot read it, while
   * the Next.js middleware can still make server-side redirect decisions. The
   * refresh token is deliberately *not* httpOnly-friendly for cross-origin use:
   * it is SameSite=None in production so the SPA on a different origin can
   * present it, and it is rotated on every use.
   */
  setCookie(c, COOKIE_ACCESS, session.accessToken, {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'None' : 'Lax',
    path: '/',
    maxAge: session.expiresIn,
  });
  setCookie(c, COOKIE_REFRESH, session.refreshToken, {
    httpOnly: false,
    secure: isProd,
    sameSite: isProd ? 'None' : 'Lax',
    path: '/api/auth',
    maxAge: 60 * 60 * 24 * 7,
  });
};

export const authRoutes = new Hono<AppEnv>()
  .post('/register', async (c) => {
    const raw = await c.req.json();

    /**
     * Role is not part of the registration DTO at all. Reject it loudly rather
     * than silently ignoring it, so a caller who *thought* they were creating a
     * CLIENT_GUEST is told the truth: guests are provisioned by a PM.
     */
    if (raw && typeof raw === 'object' && 'role' in raw) {
      throw new AppError(
        'ROLE_NOT_SELF_REGISTERABLE',
        'You cannot choose your own role. Client accounts are created by a Product Manager.',
      );
    }

    const body = parseOrThrow(
      z.strictObject({
        email: emailSchema,
        password,
        name: safeText(120),
        department,
      }),
      raw,
    );

    const session = await authService.register(body);
    setAuthCookies(c, session);
    return c.json(session, 201);
  })

  .post('/login', async (c) => {
    const body = parseOrThrow(z.object({ email: emailSchema, password: z.string().min(1) }), await c.req.json());

    const session = await authService.login({
      ...body,
      meta: {
        userAgent: c.req.header('user-agent'),
        ip: c.req.header('x-forwarded-for')?.split(',')[0]?.trim(),
      },
    });

    setAuthCookies(c, session);
    return c.json(session);
  })

  .post('/refresh', async (c) => {
    // The refresh token may arrive in the cookie or the body, depending on how
    // the client stores it.
    const body = await c.req.json().catch(() => ({}));
    const presented = getCookie(c, COOKIE_REFRESH) ?? body?.refreshToken;

    const session = await authService.refresh(presented, {
      userAgent: c.req.header('user-agent'),
      ip: c.req.header('x-forwarded-for')?.split(',')[0]?.trim(),
    });

    setAuthCookies(c, session);
    return c.json(session);
  })

  .post('/logout', async (c) => {
    const isProd = env.isProduction;
    const presented = getCookie(c, COOKIE_REFRESH);
    await authService.logout(presented);

    // Hono has no deleteCookie helper; expiring a cookie is the same operation.
    const expire = { path: '/', secure: isProd, sameSite: isProd ? ('None' as const) : ('Lax' as const), maxAge: 0 };
    setCookie(c, COOKIE_ACCESS, '', { ...expire, httpOnly: true });
    setCookie(c, COOKIE_REFRESH, '', { ...expire, httpOnly: false });

    return c.json({ message: 'Signed out' });
  })

  .get('/me', async (c) => {
    const actor = c.get('actor');
    return c.json(await authService.getMe(actor));
  });
