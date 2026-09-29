# Permissions & workflow

Two independent things decide whether an action succeeds: **who** the actor is
(RBAC) and **what** the resource currently is (ABAC). Both live in
`backend/src/core/authz/`, and every route goes through them — there is no
second, looser path into the data.

## Roles

| | `PRODUCT_MANAGER` | `INTERNAL_TEAM` | `CLIENT_GUEST` |
|---|---|---|---|
| Sees | every project | projects they are a member of | their own organisation's projects |
| Creates projects / tasks | yes | no | no |
| Edits core fields (title, description, priority, department, client visibility) | yes | no | no |
| Edits scheduling (assignee, due date, estimate) | yes | the assignee only | no |
| Changes status | yes, except → `DONE` | the assignee only | no |
| Defines dependencies | yes | no | no |
| Comments / attachments | yes | on their projects | no |
| Reads the audit trail | yes | on their projects | no |
| Reads the standup | yes | yes | no |

The one rule that is easy to miss: **a PM cannot complete a task.** Moving work
to `DONE` is the executor's act. The refusal is `403 PM_CANNOT_COMPLETE`, and it
is enforced in the policy rather than in the route handler, so no path to `DONE`
bypasses it.

## Read scope

Reads are filtered in SQL, not in the UI. `readScope(actor, target)` returns a
predicate that is ANDed into every list query, and `canSeeTask()` decides
single-row visibility. The two agree by construction because both are expressed
in terms of the same helpers.

A `CLIENT_GUEST` needs **three** things to be true to see a task:

1. the task's project belongs to the actor's `clientOrgId`,
2. that project is within their scope, and
3. the task is flagged `isClientVisible`.

A guest reading another tenant's project gets `404`, not `403` — the existence of
the project is itself information the tenant boundary should not leak.

## Data masking

The brief requires that internal identities are "filtered out from the API
response, not hidden via CSS/Frontend". So masking happens in the DTO layer:
for a `CLIENT_GUEST`, the task mappers return a whitelist (`ClientTask`) rather
than deleting keys from the full object.

Dropped for a guest: `assignee`, `department`, `createdBy`, `version`,
`estimateHours`, `orderIndex`, internal (`isInternal`) comments, the audit
trail, and the resolved dependency graph. Kept: title, description, status,
priority, due date, client-visible attachments, public comments, and an
aggregate dependency count (`{ total, completed, allDone }`) — enough to explain
progress without naming internal work.

`GET /api/tasks/:id` returns *different shapes* for a guest and for staff. The
frontend has one `ClientTask` type and one `TaskDetail` type, so an accidental
render of an internal field is a type error rather than a quiet leak.

## The task state machine

```
                 ┌──────────────────────────────┐
                 │                              ▼
  TODO ──────▶ BLOCKED ─────────▶ TODO      IN_REVIEW ─────▶ DONE
    │                             │              ▲               │
    │                             └──────────────┴───────────────┘
    │                                            │
    ▼                                            │
  IN_PROGRESS ◀───────────────────────────────────┘
    │      │
    │      └──▶ IN_REVIEW
    └────────▶ DONE
```

Legal edges, and nothing else:

| From | To |
|---|---|
| `TODO` | `BLOCKED`, `IN_PROGRESS` |
| `BLOCKED` | `TODO`, `IN_PROGRESS` |
| `IN_PROGRESS` | `BLOCKED`, `IN_REVIEW`, `TODO`, `DONE` |
| `IN_REVIEW` | `IN_PROGRESS`, `DONE` |
| `DONE` | `IN_PROGRESS` (reopen), `TODO` |

A transition passes three gates, in order:

1. **Structural** — is the edge legal at all? Otherwise `422 INVALID_TRANSITION`.
2. **Attribute** — may *this* actor take it? A non-assignee internal member is
   refused (`NOT_ASSIGNEE`) even on a legal edge; a PM is refused on `DONE`
   (`PM_CANNOT_COMPLETE`); a guest is refused outright.
3. **Dependency** — reaching `IN_PROGRESS` with an unfinished prerequisite fails
   with `422 DEPENDENCY_NOT_MET`, and the response names the blocking tasks.

Gate 3 deliberately stops applying once a task is past `IN_REVIEW`: if someone
reopens a prerequisite mid-flight, the right outcome is a visible `BLOCKED`
flag, not silently un-starting another person's work.

## Dependencies

- A dependency is `(taskId, dependsOnTaskId)`: *B cannot start before A is done*.
- Self-dependency → `SELF_DEPENDENCY`; cross-project → `CROSS_PROJECT_DEPENDENCY`;
  a repeated edge → `DUPLICATE_DEPENDENCY`; anything that would close a loop →
  `CYCLE_DETECTED`.
- When a dependency's target reaches `DONE`, the **reconciler** moves the
  dependent out of `BLOCKED` back to `TODO` and writes an `AUTO_UNBLOCKED` audit
  entry. `BLOCKED` is stored, not computed at read time, so it is queryable and
  filterable like any other status.

## Optimistic concurrency

Every mutable row has an integer `version`.

- The client reads the row and keeps the version.
- Writes send it back; the update is guarded by `where: { id, version }`.
- If another writer got there first, `updateMany` matches nothing and the API
  returns `409 VERSION_CONFLICT` with the current server state, so the client can
  show what changed rather than guessing.
- The board carries the version in `dataTransfer` during a drag, so a card that
  went stale between pickup and drop is rejected rather than silently applied.

Status changes are the same mechanism: `POST /api/tasks/:id/transition` requires
`version`, and the version is bumped in the same transaction as the status and
the audit entry.

## Audit trail

`TaskLog` records every field change and every state transition with the actor,
the old and new value, and a structured `metadata` payload.

Immutability is enforced in the database by triggers that raise on `UPDATE` and
`DELETE` — so a future code path, a careless migration, or a `psql` session
cannot rewrite history. `backend/src/modules/tasks/audit.integrity.test.ts` proves
the trigger is installed by attempting exactly that.

## Standup

`GET /api/projects/:id/standup` summarises *yesterday's changes*, derived from
the audit trail rather than from live task state. A summary built from current
state would just restate the board; built from the log it reports what actually
moved, and it cannot drift from the record because it *is* the record.

The headline counts — completed, moved to in-progress, moved to review, blocked,
reopened — come with the tasks behind each number and a per-department
breakdown. It is internal: a guest is refused.
