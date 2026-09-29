# Architecture

## Shape

```
browser ──▶ Next.js 16 (App Router, client components)
                │  axios + TanStack Query
                │  access token in memory, refresh cookie httpOnly
                ▼
           Hono API (Bun.serve)
                │  cors → requestId → logger → rateLimit → auth → validateIds
                ▼
           Prisma 7 (@prisma/adapter-pg)  ──▶  PostgreSQL 17
```

Two separate git repositories, `backend/` and `frontend/`, each deployable on
its own. The API is stateless — sessions live in the database, not in memory —
so it scales horizontally, which is also what makes the in-process rate limiter
the one honest limitation in the stack (see *Known limits*).

## Backend layout

```
src/
  index.ts               Bun.serve, graceful shutdown, optional standup scheduler
  app.ts                 middleware order, route mounting, onError
  config/env.ts          zod-parsed environment, fails fast at boot
  core/authz/            the policy: scope, permissions, state machine (+ tests)
  lib/                   prisma client, errors, jwt, ezfilter query wrapper
  middleware/            auth (bearer + cookie), requestId/logger/rateLimit/validateIds
  modules/
    auth/                register, login, rotate, logout, me
    projects/            projects, membership, task + dependency + comment +
                         attachment routes, client-org listing
    tasks/               task service, transition service, dependency service,
                         audit service, DTO mappers (incl. client masking)
    standup/             audit-derived daily summary
    shared/schemas.ts    the shared Zod primitives
```

**Routes are thin.** A route parses a body with Zod, calls a service, and
returns. Every decision — who may do this, is this transition legal, is this
version current — happens in a service or in `core/authz`, so the same rules
apply no matter which endpoint asks.

**`app.onError` rather than a `try/catch` middleware.** Hono wraps each handler
individually and routes a throw straight to the error handler, so a wrapping
middleware never fires. The `onError` handler translates Prisma's known request
errors into the same codes the domain layer uses, and in production returns a
generic message rather than a driver string.

**`core/authz` is pure.** `can()` never throws; `assertCan()` is the enforcing
wrapper. That split is what lets the same function answer "is this button
disabled?" for the UI and "is this request allowed?" for the API — the two
cannot disagree, because there is only one implementation.

## Data model

```
ClientOrganization ──< Project ──< Task ──< TaskDependency >── Task
                              │        │
                              │        ├──< TaskLog      (append-only, trigger-enforced)
                              │        ├──< Comment      (isInternal marks internal threads)
                              │        └──< Attachment
                              │
                              └──< ProjectMember >── User
```

| Decision | Why |
|---|---|
| `TaskDependency(taskId, dependsOnTaskId)` | A dependency is an edge a task *waits on*. Modelling it as "B depends on A" makes the auto-unblock query a single indexed lookup. |
| `TaskDependency` self-relation with a uniqueness constraint | Duplicates are impossible at the schema level, not just in a check. |
| `BLOCKED` is a stored status | It is queryable, filterable and board-visible. A derived status would have to be recomputed on every read and could not be indexed. |
| `TaskLog` with `oldValue`/`newValue`/`metadata` | A standup built from the log cannot drift from the record, because it *is* the record. |
| `version` on every mutable row | The optimistic lock, enforced with `updateMany({ where: { id, version } })` so the check and the write are one statement. |
| `RefreshToken` stores a SHA-256 hash | A database dump does not hand out live sessions. Rows are revoked, never deleted, so a session's history survives logout. |
| `isClientVisible` on the task | The brief requires the client to see only flagged work; a per-relation ACL would be more flexible and much harder to prove airtight. |
| `soft delete` (`deletedAt`) on user-authored rows | Archived work still anchors the audit trail, which is trigger-protected. |

## Concurrency

A write that can be raced is guarded by the version it was read at:

```ts
const updated = await tx.task.updateMany({
  where: { id, version },
  data: { ...changes, version: { increment: 1 } },
});
if (updated.count === 0) throw AppError.versionConflict(currentState);
```

The check and the increment are the same statement, so there is no window
between "is it still current?" and "write it". Status transitions do the same
inside one transaction that also writes the audit entry, so a status change and
its history are committed together or not at all.

## Audit immutability

`TaskLog` is protected by `CREATE OR REPLACE TRIGGER` statements that raise on
`UPDATE` and on `TRUNCATE`. A trigger, rather than application code, because the
guarantee should survive a future code path, a careless migration or someone
with a `psql` session. `audit.integrity.test.ts` proves the trigger exists by
attempting exactly the operations it forbids.

## Query handling

List endpoints share one contract (`lib/query.ts`) built on
`@nodewave/prisma-ezfilter`, with two things layered on top of the library:

1. **Mandatory scoping.** The caller's read scope is ANDed into the `where`
   clause server-side, so a crafted filter cannot widen visibility.
2. **Allow-listed fields.** The filterable/sortable fields come from each
   endpoint's own spec, never from client input.

## Frontend layout

```
src/
  app/
    (auth)/             login, register — split brand panel
    (app)/              projects, projects/[id] — behind the auth guard
  components/
    ui/                 the kit: button, dialog, select, tabs, badge, pills…
    layout/             app shell, user menu, page header
    projects/           project list, detail, guest detail, metrics, members
    tasks/              board, card, task dialog, task form
    standup/            audit-derived summary
  lib/                  api client, token, types, zod schemas, utils
  hooks/                use-auth (route guards), queries (all data access)
  stores/               auth store (Zustand)
```

- **The API client owns refresh.** A 401 on anything but login/register/refresh
  triggers a single-flight refresh and one retry, so concurrent 401s cause one
  refresh rather than five. `setUnauthorizedHandler` lets the auth store drop
  the session and bounce the guards.
- **The access token is never persisted.** It lives in module scope, so an XSS
  payload cannot read it back out of `localStorage`. A reload restores the
  session from the httpOnly refresh cookie.
- **The API drives the UI.** `permittedTransitions`, `permissions` and
  `transition-options` are all computed server-side; the frontend renders what it
  is told and re-derives no policy. A client guest gets a different component
  tree entirely (`GuestProjectDetail`) reading a different type (`ClientTask`),
  so an accidental render of an internal field is a type error.
- **Route protection is client-side.** The refresh cookie is scoped to
  `/api/auth` and is not readable at app paths, so there is nothing on the
  server to gate on. The guard lives in `useRequireAuth`; the API is the real
  boundary, and every request re-checks.

## Known limits

- The rate limiter is in-process, so it is per-instance. Correct for a single
  node, and honest about the fact that it is not a distributed quota. The
  interface is narrow enough to swap for Redis without touching a route.
- Access tokens carry no revocation list: a leaked access token is valid until
  it expires (15 minutes). Logout revokes the refresh token, which is the
  long-lived credential.
- Attachments are stored on the API's local disk. Two API instances would need
  shared storage; nothing else in the design assumes a single node.
- The standup scheduler is an in-process timer (`STANDUP_CRON_ENABLED`). With
  more than one instance it would run more than once, which is harmless because
  the report is derived, not stored.
