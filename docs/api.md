# API reference

Base URL: `http://localhost:3000` locally.

All responses are JSON. Errors always use one envelope:

```json
{ "error": { "code": "FORBIDDEN", "message": "…", "details": {}, "requestId": "…" } }
```

`code` is a stable machine-readable string — the UI reacts to it (disable a
control, show a conflict notice) rather than matching on `message`, which is
human-facing and free to change. The full list lives in
`backend/src/lib/errors.ts`.

## Conventions

**Authentication.** `Authorization: Bearer <accessToken>`. Access tokens are
short-lived (15m) and the client holds them in memory only. A long-lived
refresh token is set as an httpOnly cookie and rotated on every use.

**Concurrency.** Every mutating call needs the row's current `version`, either
as an `If-Match: "3"` header or as `"version": 3` in the body. Omitting it is a
`422 VALIDATION_ERROR` rather than a silent last-write-wins. A stale version is
`409 VERSION_CONFLICT`, and the response carries the current server state:

```json
{ "error": { "code": "VERSION_CONFLICT", "message": "…", "details": { "current": { "…": "…" } } } }
```

**Lists.** Every collection takes the same query string, implemented once in
`backend/src/lib/query.ts`:

| Parameter | Example | Meaning |
|---|---|---|
| `filters` | `{"status":["TODO","BLOCKED"],"priority":"HIGH"}` | JSON-encoded equality/containment filters |
| `searchFilters` | `{"title":"login","description":"oauth"}` | Case-insensitive substring search |
| `rangedFilters` | `[{"key":"dueDate","start":"2026-01-01","end":"2026-03-01"}]` | Range predicates |
| `orderKey` / `orderRule` | `orderKey=createdAt&orderRule=desc` | Sorting |
| `page` / `rows` | `page=1&rows=20` | Pagination (`rows` max 100) |

Response shape is always:

```json
{ "data": [ … ], "meta": { "page": 1, "rows": 20, "total": 42, "totalPage": 3, "hasNextPage": true, "hasPrevPage": false } }
```

Filters are ANDed server-side with the caller's read scope, and the field
allow-list comes from the endpoint, not from the client — so a crafted
`?filters={"clientOrgId":"…"}` is rejected rather than honoured.

**Path ids.** A malformed UUID is `400 INVALID_ID`, caught before the query
reaches the database.

---

## Health

### `GET /health`

`200` when the database is reachable, `503` otherwise. Unauthenticated.

```json
{ "status": "ok", "database": "up", "uptime": 412, "env": "development" }
```

## Auth

### `POST /api/auth/register`

Public. Self-registration can only create an `INTERNAL_TEAM` account. Sending a
`role` key is rejected outright with `403 ROLE_NOT_SELF_REGISTERABLE` — a client
guest exists only because a PM invited them.

```json
{ "name": "Sari Andriani", "email": "sari@example.com", "password": "Password123!", "department": "FRONTEND" }
```

Sets `nw_access` + `nw_refresh` cookies and returns the session.

### `POST /api/auth/login`

```json
{ "email": "pm@nodewave.dev", "password": "Password123!" }
```

Wrong credentials: `401 INVALID_CREDENTIALS`. Rate limited to 30 requests per
minute per IP across the auth surface.

### `POST /api/auth/refresh`

Reads the `nw_refresh` cookie (or a `refreshToken` in the body), rotates it and
returns a full session. The presented token is revoked, so a replay after
rotation fails with `401 TOKEN_EXPIRED`. Exempt from the auth rate limiter: it
presents a high-entropy token, not a guessable credential, and counting it would
sign out everyone behind a shared NAT.

### `POST /api/auth/logout`

Revokes the presented refresh token and clears both cookies.

### `GET /api/auth/me`

The current user, plus `accessibleProjects` so the web app can scope its
navigation.

```json
{ "id": "…", "name": "Rani Prameswari", "email": "pm@nodewave.dev", "role": "PRODUCT_MANAGER", "department": "PRODUCT", "clientOrgId": null, "avatarUrl": null, "accessibleProjects": [ … ] }
```

## Projects

### `GET /api/projects` · `POST /api/projects`

`GET` returns the caller's projects with a `taskCount` each. `POST` is
PM-only.

```json
{ "name": "Kopi Kita POS System", "code": "KKI-POS", "description": "…", "clientOrgId": "…", "startDate": "2026-09-19", "dueDate": "2026-10-29", "status": "ACTIVE" }
```

### `GET /api/projects/:id` · `PATCH /api/projects/:id`

`PATCH` needs `version`. PM-only. A guest reaching another tenant's project gets
`404`, not `403`.

### `GET /api/projects/:id/metrics`

Aggregate progress, which is all a client guest is ever given:

```json
{
  "projectId": "…", "projectName": "…", "status": "ACTIVE", "dueDate": "…",
  "totalTasks": 7, "completionPercent": 28,
  "byStatus": { "TODO": 3, "BLOCKED": 1, "IN_PROGRESS": 2, "IN_REVIEW": 0, "DONE": 1 },
  "byDepartment": { "FRONTEND": { "total": 2, "done": 1, "completionPercent": 50 } }
}
```

`byDepartment` is omitted for a `CLIENT_GUEST`.

### `GET /api/projects/:id/tasks` · `POST /api/projects/:id/tasks`

The board's data source, with the standard list contract. For a client guest
this returns the masked `ClientTask` shape and only tasks flagged
`isClientVisible`.

`POST` is PM-only:

```json
{ "title": "Offline sync engine", "description": "…", "priority": "HIGH", "department": "BACKEND", "assigneeId": "…", "isClientVisible": true, "dueDate": "2026-10-15", "estimateHours": 24 }
```

### `GET /api/projects/:id/members` · `POST /api/projects/:id/members`

`POST` is the PM-only invite path, and the only way a `CLIENT_GUEST` account
comes into existence:

```json
{ "name": "Citra Dewi", "email": "client@kopikita.id", "password": "Password123!", "role": "CLIENT_GUEST", "department": null }
```

### `GET /api/projects/:id/standup?date=YYYY-MM-DD`

What changed on the day before `date` (yesterday by default), derived from the
audit trail. Includes a `headline` (`completedYesterday`, `movedToInProgress`,
`movedToReview`, `blockedToday`, `reopened`, `totalChanges`), the tasks behind
each count, a per-department breakdown, and an in-flight list. Internal only.

### `GET /api/client-orgs`

Organisations available to the caller. A PM gets all of them (to pick one when
creating a project); a client guest gets only their own, and the endpoint is
useless to anyone else.

## Tasks

### `GET /api/tasks/:id`

The full detail view, or the masked `ClientTask` for a guest. For staff it adds
`prerequisites` and `dependents` (resolved as `{ id, taskId, title, status,
department }`), `blockers`, `attachments`, `comments`, and two things the UI
uses instead of re-deriving policy:

- `permittedTransitions: { to, allowed, code?, message? }[]`
- `permissions: Record<string, boolean>` over `task:updateCore`,
  `task:updateMeta`, `task:setClientVisible`, `task:manageDependencies`,
  `task:softDelete`, `task:readLogs`, `attachment:upload`, `comment:create`

### `PATCH /api/tasks/:id`

Needs `version`. Fields are authorised separately:

| Fields | Required permission |
|---|---|
| `title`, `description`, `priority`, `department` | `task:updateCore` (PM) |
| `isClientVisible` | `task:setClientVisible` (PM) |
| `dueDate`, `estimateHours`, `assigneeId`, `orderIndex` | `task:updateMeta` (PM or assignee) |

### `DELETE /api/tasks/:id?version=3`

Soft delete, PM-only. The row stays for the audit trail and reports
`deletedAt`.

### `POST /api/tasks/:id/transition`

```json
{ "to": "IN_REVIEW", "version": 4, "note": "ready for review" }
```

Checks the state machine, the actor's attributes, dependency satisfaction and
the version, all in one transaction that also writes the audit entry. Typical
failures: `422 INVALID_TRANSITION`, `422 DEPENDENCY_NOT_MET` (names the
blockers), `403 PM_CANNOT_COMPLETE`, `403 NOT_ASSIGNEE`.

### `GET /api/tasks/:id/transition-options`

The authoritative allow-list, used to render the board and the task dialog:

```json
{
  "taskId": "…", "currentStatus": "BLOCKED",
  "blockers": [{ "taskId": "…", "title": "Payments & KYC API", "status": "IN_PROGRESS" }],
  "options": [
    { "to": "TODO", "allowed": true },
    { "to": "IN_PROGRESS", "allowed": false, "code": "DEPENDENCY_NOT_MET", "reason": "dependency-not-met", "message": "This task is blocked by 1 unfinished task" },
    { "to": "IN_REVIEW", "allowed": false, "code": "INVALID_TRANSITION", "reason": "illegal-state-edge", "message": "A task cannot move from Blocked to In Review" }
  ]
}
```

Every status is listed, allowed or not, so the UI can render a disabled button
with a reason instead of hiding the option.

### `GET|POST /api/tasks/:id/dependencies`

`GET` returns `{ prerequisites, dependents, blockers }` — what this task waits
for, what waits for it, and which prerequisites are unfinished. `POST` is
PM-only and takes `{ "dependsOnTaskId": "…" }`; it reconciles immediately, so
adding a blocker moves the dependent to `BLOCKED` in the same transaction.

Rejections: `422 SELF_DEPENDENCY`, `422 CROSS_PROJECT_DEPENDENCY`,
`409 DUPLICATE_DEPENDENCY`, `422 CYCLE_DETECTED`.

### `DELETE /api/tasks/:id/dependencies/:dependencyId`

PM-only. Also reconciles, so removing a blocker returns the dependent to `TODO`
with an `AUTO_UNBLOCKED` audit entry.

### `GET|POST /api/tasks/:id/comments`

`GET` returns `{ data, meta }`. For a client guest the query itself excludes
internal threads — the rows are never fetched, not filtered afterwards. `POST`
takes `{ "body": "…", "isInternal": true }`; rate limited, and refused for a
guest.

### `GET|POST /api/tasks/:id/attachments`

`POST` is `multipart/form-data` with a `file` part, 10 MB max, rate limited to
20/min. Staff only; refused for a guest. The file is stored under a
server-generated name, and the response's `fileUrl` points back at the API.

### `GET /api/attachments/:id`

Streams the file, but only to someone who is allowed to read the task it hangs
off — the same `canSeeTask` decision, including the client-visible rule. A guest
asking for a file on a task that was never shared with them gets `404`, not
`403`: they should not learn the attachment exists. Files are served
`Content-Disposition: attachment` from a path outside the web root, so a
static-file shortcut cannot hand out another tenant's work.

### `GET /api/tasks/:id/logs?rows=50`

The task's audit trail, newest first, with the actor and old/new values.
Internal only — a guest is refused `403`, and no amount of query crafting gets
around it.

## Error codes

| Code | HTTP | When |
|---|---|---|
| `INVALID_ID` | 400 | A path parameter is not a UUID |
| `UNAUTHORIZED` / `TOKEN_EXPIRED` / `INVALID_CREDENTIALS` | 401 | Missing, expired or wrong credential |
| `FORBIDDEN` / `PM_CANNOT_COMPLETE` / `NOT_ASSIGNEE` / `INTERNAL_MEMBER_FORBIDDEN` / `ROLE_NOT_SELF_REGISTERABLE` | 403 | Authenticated but not permitted |
| `NOT_FOUND` | 404 | Missing, or outside the caller's scope |
| `VALIDATION_ERROR` | 422 | Body failed validation, or a required `version` was absent |
| `DEPENDENCY_NOT_MET` / `INVALID_TRANSITION` / `SELF_DEPENDENCY` / `CROSS_PROJECT_DEPENDENCY` | 422 | Workflow refused |
| `CYCLE_DETECTED` | 422 | The dependency would close a loop |
| `CONFLICT` / `DUPLICATE_DEPENDENCY` / `EMAIL_ALREADY_REGISTERED` | 409 | Uniqueness |
| `VERSION_CONFLICT` | 409 | Someone else wrote first |
| `PAYLOAD_TOO_LARGE` / `UNSUPPORTED_MEDIA_TYPE` | 413 / 415 | Upload rejected |
| `RATE_LIMITED` | 429 | Too many requests; `retry-after` header set |
| `INTERNAL_ERROR` | 500 | Unexpected — logged with the `requestId` |
