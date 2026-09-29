import { createApp } from './app.ts';
import { env } from './config/env.ts';
import { prisma } from './lib/prisma.ts';
import { startStandupScheduler } from './modules/standup/standup.service.ts';

const app = createApp();

/**
 * Bun serves the Hono app directly. `fetch` is exported so tests can drive the
 * same app in-process without binding a port.
 */
const server = Bun.serve({
  port: env.PORT,
  fetch: app.fetch,
});

console.log(`[nodewave] API listening on http://localhost:${server.port} (${env.NODE_ENV})`);

if (env.STANDUP_CRON_ENABLED) {
  console.log('[nodewave] standup scheduler enabled');
  startStandupScheduler();
}

const shutdown = async (signal: string) => {
  console.log(`[nodewave] ${signal} received, shutting down`);
  await server.stop(true);
  await prisma.$disconnect();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

export { app };
