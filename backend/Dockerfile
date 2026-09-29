# syntax=docker/dockerfile:1

# ─── prod-deps ───────────────────────────────────────────────────────────────
# Production-only install. Kept separate from the build deps because the CLI in
# the build stage (biome, tsc, @types/*) is ~150MB of the 478MB node_modules and
# has no business in a runtime image. `prisma` sits in `dependencies`, not
# `devDependencies`, precisely so this install still contains the CLI — the
# deploy's pre-deploy step runs `prisma migrate deploy` inside this image.
FROM oven/bun:1.4 AS prod-deps
WORKDIR /app
ENV NODE_ENV=production
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# ─── build ───────────────────────────────────────────────────────────────────
# Full install (dev deps included) because the Prisma client and TypeScript both
# need them. The client is generated into src/generated (see prisma/schema.prisma),
# so the sources must be present before generate runs.
FROM oven/bun:1.4 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
# `prisma generate` needs no database, which is what makes it safe to run in the
# build phase: Railway does not inject DATABASE_URL until the container starts,
# so a generate that reached for the connection would fail the build.
RUN bunx prisma generate

# ─── runtime ─────────────────────────────────────────────────────────────────
# Non-root, production dependencies only, source as TypeScript (Bun runs it
# directly, so there is no compile step and nothing to transpile).
FROM oven/bun:1.4-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    UPLOAD_DIR=/data/uploads
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data/uploads \
 && chown -R bun:bun /data
COPY --from=prod-deps --chown=bun:bun /app/node_modules ./node_modules
COPY --from=build --chown=bun:bun /app/src ./src
COPY --from=build --chown=bun:bun /app/prisma ./prisma
COPY --from=build --chown=bun:bun /app/prisma.config.ts ./prisma.config.ts
COPY --from=build --chown=bun:bun /app/package.json ./package.json
USER bun
EXPOSE 3000
# Attachment storage is the only thing the API keeps on disk. A Railway
# Volume must be attached and mounted at /data (Service Settings > Volumes)
# or files vanish on every deploy. Docker's VOLUME instruction is not
# supported by Railway's Dockerfile builder and is intentionally omitted.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT??3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "run", "start"]
