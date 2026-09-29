# Testing

Four layers, each answering a different question. The interesting assertions
are the negative ones: most of what matters here is what the system *refuses*
to do.

| Layer | Command | Count | Needs a server? |
|---|---|---|---|
| Policy unit tests | `bun test` | 40 | no |
| API smoke | `./scripts/smoke.sh` | 39 | yes |
| Browser journeys | `node scripts/journeys.mjs <dir>` | 6 journeys | yes |
| Types and lint | `bunx tsc --noEmit` / `bunx biome check` | — | no |

## 1. Policy unit tests — `bun test`

`src/core/authz/*.test.ts` test the permission matrix directly, with no
database and no HTTP. The state machine in `transition-policy.ts` is the
highest-value thing in the codebase to test in isolation: it is pure, it has a
dozens-of-cases matrix, and a wrong answer here is a security bug.

`authorize.test.ts` (13) covers read scoping per table — a guest is scoped by
`clientOrgId` on projects but *through the project relation* on tasks, which is
exactly the kind of difference a hand-written check gets wrong — plus the
internal/guest visibility split, the core-edit boundary, and the narrower
scheduling-metadata boundary.

`transition-policy.test.ts` (18) walks every edge of the state machine: the
straight-through executor path, completion after review, backward moves out of
`DONE`, and — for each — whether a PM may act, whether an assignee may act, and
whether a non-assignee may *not*. It also asserts the error precedence (an
illegal edge is `INVALID_TRANSITION` even when the actor would have been
refused anyway) and that the deny *reason* survives, since the UI turns that
reason into a tooltip.

`auth.service.test.ts` (6) is a regression suite for a real bug: `issueSession`
minted an opaque random refresh token while `refresh()` verified a JWT, so every
refresh failed and every hard reload logged the user out. It pins the fix — the
`jti` of the refresh JWT *is* the `RefreshToken` row id — and then covers
rotation, replay of a rotated-out token, logout, and an access token being
passed where a refresh token belongs.

`audit.integrity.test.ts` (3) proves the append-only guarantee lives in the
database: it attempts `UPDATE` and `DELETE` on a `TaskLog` row and asserts both
are refused by the trigger and the row is untouched. A test asserting "the
service does not mutate logs" would pass even if the service were replaced next
month; this one fails if anyone drops the trigger.

## 2. API smoke — `./scripts/smoke.sh`

39 assertions over real HTTP against a running server, ordered so each section
assumes the previous one's state. It logs in as all eight seed accounts and
walks:

- **auth** — bad password, unauthenticated list, and that `CLIENT_GUEST` is not
  self-registerable by passing the role explicitly.
- **tenant isolation** — a second client organisation's project is invisible,
  unreadable, and un-completable; a non-member gets `403` rather than a filtered
  list.
- **guest masking** — the guest payload contains no internal-only task, no
  `assigneeId`/`isClientVisible`/`internal comments`, and the client-visible
  dependency counter is the whitelisted shape.
- **the PM completion rule** — `IN_PROGRESS → DONE` is `PM_CANNOT_COMPLETE`; a
  non-assignee is `NOT_ASSIGNEE`; an internal member cannot rewrite the
  description; the assignee completes via review.
- **dependency auto-unblock** — completing the last prerequisite reconciles the
  dependent to `TODO` and writes an `AUTO_UNBLOCKED` audit entry.
- **optimistic locking** — two writers holding the same version: one gets 200,
  the other 409 `VERSION_CONFLICT`, and the first writer's value survived.
- **cycles** — a dependency that would close a loop is `CYCLE_DETECTED`.
- **attachments** — upload returns a server-owned URL, staff download works, no
  session is 401, a guest cannot upload, a guest *can* download a file on a
  shared task, and gets **404** (not 403) for one on an internal task.
- **request hygiene** — a malformed UUID in the path is `400 INVALID_ID` and an
  unknown one is `404 NOT_FOUND`, so a client mistake is never reported as a
  server fault with a Prisma message attached.

It mutates data (it completes tasks and uploads files), so re-seed afterwards:

```bash
bunx prisma db seed
```

## 3. Browser journeys — `node scripts/journeys.mjs`

Drives the real app in a real Chrome, with a fresh browser context per role so
one session's cookies cannot leak into the next. Every journey asserts on the
DOM, not on screenshots, and the run fails on unexpected console errors or
failed network requests. It covers: the unauthenticated redirect, the PM
(board, task dialog, standup, members), an internal team member, and a client
guest (no internal-only task, no internal badges or controls, no other tenant's
project, and a session that survives a hard reload).

It also produces the 11 screenshots in `docs/screenshots/`. Playwright is not a
project dependency — nothing in the build needs it, and the bundled browser
would add ~170MB to every install:

```bash
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 bun add -d playwright
node scripts/journeys.mjs /tmp/shots
```

## Running everything

In the API repository, with the server running:

```bash
cd backend
bunx tsc --noEmit && bunx biome check . && bun test && ./scripts/smoke.sh
```

In the web repository, with both servers running:

```bash
bunx tsc --noEmit && bunx biome check . && bun run build && node scripts/journeys.mjs /tmp/shots
```

## What is deliberately not tested

- **Prisma query construction.** The interesting part of a list endpoint is the
  scoping clause, and that is tested at the policy layer and through the smoke
  test's isolation assertions.
- **Component snapshots.** A snapshot of a task dialog would happily change to
  match a regression. The journeys assert the specific facts the brief requires
  (a locked button explains itself; a guest sees no internal controls), which is
  also what makes them useful as a regression net.
- **Load and concurrency under real contention.** The optimistic-lock test fires
  two writers sequentially, which exercises the same
  `updateMany({ where: { id, version } })` guard but does not prove behaviour
  under simultaneous load.
