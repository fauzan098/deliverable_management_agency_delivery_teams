import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { env } from './config/env.ts';
import { prisma } from './lib/prisma.ts';
import { type AppEnv, requireAuth } from './middleware/auth.ts';
import { onError, rateLimit, requestId, validateIds } from './middleware/common.ts';
import { authRoutes } from './modules/auth/auth.routes.ts';
import { attachmentRoutes, clientOrgRoutes, projectRoutes, taskRoutes } from './modules/projects/routes.ts';
/**
 * The Hono application.
 *
 * Middleware order is load-bearing:
 *
 *   cors -> requestId -> logger -> rateLimit -> auth -> validateIds -> handler
 *
 * Error translation is registered via `app.onError` rather than as a middleware,
 * because Hono's dispatcher catches a throw at the handler that raised it and
 * calls `onError` directly — a wrapping `try/catch` middleware would never see
 * it.
 */
export function createApp() {
  const app = new Hono<AppEnv>();

  app.use(
    '*',
    cors({
      origin: (origin) => {
        // Same-origin/non-browser callers send no Origin header.
        if (!origin) return origin;
        return env.corsOrigins.includes(origin) ? origin : null;
      },
      credentials: true,
      allowHeaders: ['Content-Type', 'Authorization', 'If-Match', 'X-Request-Id'],
      exposeHeaders: ['X-Request-Id'],
      maxAge: 86400,
    }),
  );

  app.use('*', requestId());
  app.use('*', logger());

  app.onError(onError);

  app.get('/health', async (c) => {
    let database = 'down';
    try {
      await prisma.$queryRaw`SELECT 1`;
      database = 'up';
    } catch {
      database = 'down';
    }
    return c.json(
      {
        status: database === 'up' ? 'ok' : 'degraded',
        database,
        uptime: Math.round(process.uptime()),
        env: env.NODE_ENV,
      },
      database === 'up' ? 200 : 503,
    );
  });

  // Authentication must be registered *before* the routes it guards: Hono runs
  // middleware in registration order, so declaring it afterwards would leave
  // every route reachable without a session. `requireAuth` exempts the public
  // auth paths and `/health` itself.
  app.use('/api/*', requireAuth());

  // A coarse limiter on the auth surface, in addition to the per-route ones
  // declared inside the task routes. `/refresh` is exempt: it presents a
  // high-entropy, already-rotated token rather than a guessable credential, and
  // counting it would log out everyone behind a shared office NAT.
  app.use('/api/auth/*', rateLimit({ windowMs: 60_000, max: 30, skip: (path) => path === '/api/auth/refresh' }));

  // Malformed path ids are a client mistake, and saying so is more useful than
  // the 500 a driver-level uuid cast error would produce.
  app.use('/api/*', validateIds());

  app.route('/api/auth', authRoutes);
  app.route('/api/projects', projectRoutes);
  app.route('/api/tasks', taskRoutes);
  app.route('/api/attachments', attachmentRoutes);
  app.route('/api/client-orgs', clientOrgRoutes);

  app.notFound((c) =>
    c.json({ error: { code: 'NOT_FOUND', message: `No route for ${c.req.method} ${c.req.path}` } }, 404),
  );

  return app;
}

export type App = ReturnType<typeof createApp>;
