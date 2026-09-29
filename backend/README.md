# NodeWave API

Bun + Hono + Prisma 7 over PostgreSQL. Owns authentication, the permission
model, the task state machine, and the audit trail.

The permission rules live in [`src/core/authz`](src/core/authz) as pure
functions; routes are thin and delegate to services. See
[docs/permissions.md](../docs/permissions.md) for the rules and
[docs/architecture.md](../docs/architecture.md) for the design.

## Run it

```bash
cp .env.example .env          # then set DATABASE_URL
docker compose up -d          # postgres on :55432
bun install
bunx prisma migrate deploy
bunx prisma db seed
bun run dev                   # http://localhost:3000
```

`./scripts/dev-server.sh {start|stop|restart|status|logs}` runs the same thing
with a pidfile in `/tmp`, which is handy when a second process is already
holding port 3000.

## Scripts

| Script | Does |
|---|---|
| `dev` | `bun --watch src/index.ts` |
| `start` | production entrypoint |
| `typecheck` / `lint` | `tsc --noEmit` / `biome check` |
| `test` | `bun test` — 40 policy and auth tests, no database needed |
| `db:migrate` | `prisma migrate deploy` (safe to re-run) |
| `db:migrate:dev` | `prisma migrate dev` (creates a migration) |
| `db:seed` | the demo tenants, projects, tasks and users |
| `db:studio` | Prisma Studio |
| `release` | `migrate deploy` + seed — deploy-time convenience, demo only |

## Testing

```bash
bun test            # policy units: authz matrix, state machine, refresh rotation,
                    # and the DB trigger that makes the audit log append-only
./scripts/smoke.sh  # 39 assertions over real HTTP against a running server
```

`smoke.sh` mutates data. Re-seed with `bunx prisma db seed` afterwards.

## Layout

```
src/
  app.ts             middleware order + route mounting (the load-bearing file)
  config/env.ts      Zod-parsed environment; refuses to boot on bad config
  core/authz/        read scope, permissions, state machine — all pure
  lib/               prisma, errors, jwt, query helper
  middleware/        auth, requestId, logger, rateLimit, validateIds, onError
  modules/           auth, projects, tasks, standup
prisma/
  schema.prisma      datasource URL lives in prisma.config.ts (Prisma 7)
  migrations/        includes the append-only trigger on TaskLog
  seed.ts            idempotent: upserts by fixed id
```

## Gotchas worth knowing before you edit

- **`requireAuth` is registered before `app.route(...)`.** Hono runs middleware
  in registration order, so declaring it afterwards leaves every route open.
- **Errors go through `app.onError`, not a `try/catch` middleware.** Hono
  dispatches a handler's throw straight to the error handler; a wrapping
  middleware never sees it.
- **The Prisma client is generated into `src/generated/prisma`**, and the
  datasource URL comes from `prisma.config.ts`. Run `bunx prisma generate` after
  changing the schema.
- **`migrate reset` wants `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION=1`.**
- **`prisma` is a runtime dependency, not a dev one.** The production image is
  installed with `--production` and the deploy's pre-deploy step runs
  `prisma migrate deploy` inside it. Moving `prisma` back to
  `devDependencies` would break deploys quietly — the API would start against an
  empty database. For the same reason `prisma.config.ts` imports `dotenv`
  dynamically.
- **The pg adapter mislabels `restrict_violation` as a foreign-key error** when
  translating Prisma errors, so don't trust that code blindly for `restrict`.

## Deployment

Dockerfile + `railway.json` are included; see
[docs/deployment.md](../docs/deployment.md) for the environment variables, the
volume needed for attachments, and the post-deploy checks.
