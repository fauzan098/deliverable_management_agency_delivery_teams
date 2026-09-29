import { defineConfig } from 'prisma/config';

/**
 * Load a local `.env` when there is one.
 *
 * The import is dynamic and optional on purpose. This file is executed by the
 * Prisma CLI in three places: a developer's laptop, a CI job, and the deployed
 * container's pre-deploy step. Only the first has a `.env` file *and* the
 * `dotenv` package installed — the production image is installed with
 * `--production`, so a static `import 'dotenv'` here would make
 * `prisma migrate deploy` fail at deploy time with ERR_MODULE_NOT_FOUND, before
 * it ever reached the database.
 *
 * A deployed environment already has DATABASE_URL and the JWT secrets injected
 * by the platform, so there is nothing for dotenv to do there.
 */
try {
  const { config } = await import('dotenv');
  config();
} catch {
  // No dotenv (production install) or no .env to read. Either way the
  // environment is already populated, which is all this call was for.
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'bun run prisma/seed.ts',
  },
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
