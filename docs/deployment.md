# Deployment

Two independently deployable apps. The API needs a PostgreSQL database; the web
app only needs to know the API's URL.

```
PostgreSQL 17  ──▶  API (Railway, Docker)  ──▶  Web (Vercel)
```

**Deploy the API first.** The web app's `NEXT_PUBLIC_BE_URL` is inlined at build
time, so the API's public URL has to exist before the web app is built. Doing it
the other way round means a second deploy.

## Environment variables

### API

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | `postgresql://user:pass@host:5432/db?schema=public` |
| `JWT_ACCESS_SECRET` | yes | ≥32 chars. **Different value per environment.** |
| `JWT_REFRESH_SECRET` | yes | ≥32 chars, and not equal to the access secret. |
| `CORS_ORIGINS` | yes (in production) | Comma-separated exact origins of the web app. Defaults to `http://localhost:3000`, which is never right once deployed. No trailing slash, no `*` — matching is exact. |
| `PORT` | no | Defaults to 3000; platforms inject their own. |
| `NODE_ENV` | no | `production` in deployed environments. |
| `JWT_ACCESS_TTL` | no | Default `15m`. |
| `JWT_REFRESH_TTL` | no | Default `7d`. |
| `UPLOAD_DIR` | no | Default `./uploads`; the image sets `/data/uploads`. |
| `MAX_UPLOAD_SIZE_MB` | no | Default `10`. |
| `STANDUP_CRON_ENABLED` | no | `true` to run the in-process daily summary. |
| `STANDUP_CRON_HOUR` | no | Server-local hour for that job. |

The API refuses to boot on a missing or short secret — `config/env.ts` parses
with Zod and throws. A deployment that starts with a weak secret is worse than
one that does not start.

Generate the two secrets with `openssl rand -base64 48` and keep them out of
`railway.json`; manage them as service variables so they never reach git.

### Web

| Variable | Required | Notes |
|---|---|---|
| `NEXT_PUBLIC_BE_URL` | yes | Base URL of the API, e.g. `https://nodewave-api.up.railway.app`. No trailing slash, no `/api`. |

`NEXT_PUBLIC_*` values are inlined at **build** time, so changing the API URL
requires a rebuild, not just a restart. In Vercel, set it in
Settings → Environment Variables for all three environments.

## API on Railway

```bash
cd backend
railway login
railway init
railway add --database postgres
railway variables set \
  JWT_ACCESS_SECRET="$(openssl rand -base64 48)" \
  JWT_REFRESH_SECRET="$(openssl rand -base64 48)" \
  NODE_ENV=production
railway up
```

Then seed the demo accounts — this is the one manual step:

```bash
railway run bun run prisma/seed.ts
```

Check the deployment log for a `pre-deploy` phase. It should show the three
migrations being applied before the container starts serving. If that phase is
missing, `preDeployCommand` did not run and the database is empty — every
request will 500 until you apply the schema by hand:

```bash
railway run bunx prisma migrate deploy
```

**Seeding is not a migration.** It is idempotent — the seed upserts by fixed id,
so re-running it restores the demo state — but it is demo data. Do not put it in
`preDeployCommand`, or every deploy would reset the database underneath anyone
using the deployment.

`bun run release` does migrate + seed in one step. Convenient for a throwaway
demo database, wrong for anything you intend to keep.

### Why migrations run as a pre-deploy command

Migrations cannot run in the Docker build phase: Railway does not inject
`DATABASE_URL` until the container starts, so a build-time `migrate deploy` fails
before it reaches the database. They also should not be in `CMD` on every boot —
with more than one replica that races, and a failed migration would take the
service down rather than leaving the previous version serving.

That is why `prisma` sits in `dependencies` rather than `devDependencies`: the
production image is installed with `--production`, and the pre-deploy step runs
`bunx prisma migrate deploy` *inside that image*. The same reason
`prisma.config.ts` loads `dotenv` through a dynamic import — see the comment in
that file. Verified: `bunx prisma migrate deploy` and the seed both run
successfully inside the built image with no `.env` file present.

### The image

`Dockerfile` is a three-stage build: `prod-deps` (production install), `build`
(full install, runs `prisma generate`), and a non-root `runtime` on
`oven/bun:1.4-slim`. The generated Prisma client is built in the `build` stage
and copied in, so the runtime needs neither the dev dependencies (~150 MB of
biome and TypeScript) nor a compile step — Bun executes the TypeScript directly.

Local verification of that image: 163 MB, `docker inspect` healthy, `/health`
returning `{"status":"ok","database":"up","env":"production"}`, seeded logins
working over HTTP, and `Set-Cookie` carrying `Secure; SameSite=None` as the
cross-origin cookie design requires.

### Attachments need a volume

The API writes uploads to `UPLOAD_DIR`, the only state it keeps on disk. On
Railway, add a volume mounted at `/data` (the image already sets
`UPLOAD_DIR=/data/uploads` and declares `VOLUME ["/data"]`). Without one,
attachments disappear on each deploy — the rows survive, the files do not.

## Web on Vercel

```bash
cd frontend
vercel link
vercel env add NEXT_PUBLIC_BE_URL production   # https://<your-api>.up.railway.app
vercel --prod
```

`vercel.json` pins Bun as the package manager, the region (`sin1`, matching the
Singapore-first seed data), and a small security header set.

The web app runs on Node.js on Vercel, not Bun. That is deliberate: it has no
Bun-specific API calls, and Vercel's Bun runtime is still beta. To switch, add
`"bunVersion": "1.x"` to `vercel.json` and prefix the dev/build scripts with
`bun --bun`.

## Post-deploy check

```bash
API=https://<your-api>.up.railway.app

curl -s $API/health
# {"status":"ok","database":"up","env":"production",...}

curl -s -X POST $API/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"pm@nodewave.dev","password":"Password123!"}' | head -c 60
```

Then open the web app and log in as each role. The three that catch the most:

| Role | Expected |
|---|---|
| `pm@nodewave.dev` | Board renders; task dialog shows every status, with `DONE` disabled and a reason |
| `fe@nodewave.dev` | The `BLOCKED` task's controls are locked with tooltips |
| `client@nusantaradigital.com` | No internal-only task, no assignee or department fields, no other tenant's project |

Then hard-reload the page. The session must survive: the browser holds the
access token in memory only, so recovering it means `POST /api/auth/refresh`
using the `nw_refresh` cookie, which is `SameSite=None; Secure` in production
for exactly this reason.

### When something looks wrong

| Symptom | Cause |
|---|---|
| CORS error in the browser, shell `curl` works | `CORS_ORIGINS` is missing the exact origin the browser used. `www.` vs non-`www`, `http` vs `https`, and each preview-deployment domain are all different origins. |
| 401 immediately after a successful login | The two JWT secrets are identical, or one changed between the login and the refresh. |
| 503 from `/health` | The database is unreachable — usually a wrong `DATABASE_URL`. The healthcheck returns 503 rather than 200 so a broken database fails the deploy instead of serving 500s. |
| Every request 500s, tables missing | The pre-deploy migration step did not run. See above. |
| Attachments 404 after a deploy | No volume mounted at `/data`. |
| Login works, then the UI signs itself out | A hard failure of the refresh call — check that the API is serving HTTPS, since `Secure` cookies are dropped over plain HTTP. |

## Free-tier limits

Worth knowing before choosing a plan, because two of these will stop working
quietly rather than error:

| | Free allowance | Consequence here |
|---|---|---|
| Railway | $1/month of usage; 0.5 GB RAM per service; 0.5 GB volume; 1 replica | The API idles around 11 MB and Postgres around 6 MB, so this is comfortable for a demo. The 0.5 GB volume is the real ceiling — fine for seed data, not for a growing attachment store. |
| Railway custom domains | none on Free | You get a `*.up.railway.app` subdomain, which is enough. |
| Vercel Hobby | free, but **non-commercial use only** | Acceptable for a portfolio or assessment demo; not for a paid product. |

Railway's free credit is spent by resource usage, so a service that idles at
150 MB of RAM can exhaust $1 in a month and be stopped. A demo deployment left
running unattended is the likely way to hit that.

## Resetting a deployed demo

```bash
railway run bunx prisma migrate reset --force   # drops, re-migrates, re-seeds
```

## Cost and scale notes

- The API is stateless apart from the upload directory, so it scales
  horizontally — with the exceptions already noted in
  [architecture](./architecture.md#known-limits): the in-process rate limiter is
  per-instance, and uploads need shared storage.
- The web app is fully static apart from `/projects/[id]`, which is dynamic
  because it reads the session. The other routes prerender at build time.
