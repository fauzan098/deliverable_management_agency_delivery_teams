#!/usr/bin/env bash
# End-to-end API smoke test. Drives the running server over HTTP and asserts the
# behaviours the brief calls out: tenant isolation, masking, PM completion rule,
# dependency blocking, and optimistic-lock conflicts.
set -uo pipefail

B=${B:-http://localhost:3000}
PASS=0
FAIL=0

j() { python3 -c "import sys,json;d=json.load(sys.stdin);$1"; }
check() {
  local name=$1 expected=$2 actual=$3
  if [ "$expected" = "$actual" ]; then
    printf '  \033[32mPASS\033[0m %s\n' "$name"; PASS=$((PASS+1))
  else
    printf '  \033[31mFAIL\033[0m %s (expected=%s actual=%s)\n' "$name" "$expected" "$actual"; FAIL=$((FAIL+1))
  fi
}

login() {
  curl -s -X POST "$B/api/auth/login" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$1\",\"password\":\"Password123!\"}"
}

echo "=== auth ==="
PM_TOK=$(login pm@nodewave.dev | j 'print(d["accessToken"])')
UX_TOK=$(login ux@nodewave.dev | j 'print(d["accessToken"])')
FE_TOK=$(login fe@nodewave.dev | j 'print(d["accessToken"])')
BE_TOK=$(login be@nodewave.dev | j 'print(d["accessToken"])')
CG_TOK=$(login client@nusantaradigital.com | j 'print(d["accessToken"])')
OP_TOK=$(login client@kopikita.id | j 'print(d["accessToken"])')
check "wrong password rejected" "401" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/api/auth/login -H 'Content-Type: application/json' -d '{"email":"pm@nodewave.dev","password":"nope"}')"
check "unauthenticated list rejected" "401" \
  "$(curl -s -o /dev/null -w '%{http_code}' $B/api/projects)"

# A CLIENT_GUEST must not be self-registerable: supplying a role is refused
# outright rather than silently ignored.
check "client guest role not self-registerable" "ROLE_NOT_SELF_REGISTERABLE" \
  "$(curl -s -X POST $B/api/auth/register -H 'Content-Type: application/json' \
     -d '{"email":"hacker+role@x.dev","password":"Password123!","name":"X","department":"FRONTEND","role":"CLIENT_GUEST"}' \
     | j 'print(d["error"]["code"])')"

echo "=== tenant isolation ==="
check "PM sees 2 projects" "2" "$(curl -s "$B/api/projects" -H "Authorization: Bearer $PM_TOK" | j 'print(len(d["data"]))')"
check "guest sees only own org (1)" "1" "$(curl -s "$B/api/projects" -H "Authorization: Bearer $CG_TOK" | j 'print(len(d["data"]))')"
check "other-tenant guest sees only own (1)" "1" "$(curl -s "$B/api/projects" -H "Authorization: Bearer $OP_TOK" | j 'print(len(d["data"]))')"

NUS=bbbbbbbb-0000-4000-8000-000000000001
KOPI=bbbbbbbb-0000-4000-8000-000000000002
check "guest cannot read other tenant project" "404" \
  "$(curl -s -o /dev/null -w '%{http_code}' "$B/api/projects/$KOPI" -H "Authorization: Bearer $CG_TOK")"
check "guest can read own project" "200" \
  "$(curl -s -o /dev/null -w '%{http_code}' "$B/api/projects/$NUS" -H "Authorization: Bearer $CG_TOK")"

# An INTERNAL_TEAM member not assigned to a project must not see it. The Kopi
# PM is a member of Kopi only; a Nusantara-only engineer must not see Kopi.
check "non-member engineer cannot read project" "403" \
  "$(curl -s -o /dev/null -w '%{http_code}' "$B/api/projects/$KOPI" -H "Authorization: Bearer $FE_TOK")"

echo "=== client data masking ==="
TASKS_GUEST=$(curl -s "$B/api/projects/$NUS/tasks?rows=50" -H "Authorization: Bearer $CG_TOK")
check "guest task list omits assignee field" "0" \
  "$(echo "$TASKS_GUEST" | j 'print(sum(1 for t in d["data"] if "assignee" in t))')"
check "guest task list omits department" "0" \
  "$(echo "$TASKS_GUEST" | j 'print(sum(1 for t in d["data"] if "department" in t))')"
check "guest task list omits version" "0" \
  "$(echo "$TASKS_GUEST" | j 'print(sum(1 for t in d["data"] if "version" in t))')"
check "guest never sees internal-only task" "0" \
  "$(echo "$TASKS_GUEST" | j 'print(sum(1 for t in d["data"] if t["title"].startswith("Migrate legacy")))')"
check "guest sees only client-visible tasks" "$(echo "$TASKS_GUEST" | j 'print(len(d["data"]))')" \
  "$(echo "$TASKS_GUEST" | j 'print(sum(1 for t in d["data"] if t["isClientVisible"] is True))')"

INTERNAL_ONLY=cccccccc-0000-4000-8000-000000000006
check "guest fetching internal task is 403" "403" \
  "$(curl -s -o /dev/null -w '%{http_code}' "$B/api/tasks/$INTERNAL_ONLY" -H "Authorization: Bearer $CG_TOK")"

echo "=== state-based permissions ==="
SLICING=cccccccc-0000-4000-8000-000000000003
# The Frontend task is blocked by the design library (DONE) and the API
# (IN_PROGRESS). Starting it must fail with the unmet dependency named.
SL_VER=$(curl -s "$B/api/tasks/$SLICING" -H "Authorization: Bearer $FE_TOK" | j 'print(d["version"])')
BLOCK_RES=$(curl -s -X POST "$B/api/tasks/$SLICING/transition" -H "Authorization: Bearer $FE_TOK" \
  -H 'Content-Type: application/json' -d "{\"to\":\"IN_PROGRESS\",\"version\":$SL_VER}")
check "blocked task cannot start (422)" "DEPENDENCY_NOT_MET" "$(echo "$BLOCK_RES" | j 'print(d["error"]["code"])')"
check "blockers are named in the error" "1" \
  "$(echo "$BLOCK_RES" | j 'print(len(d["error"]["details"]["blockers"]))')"
check "blocked task status is BLOCKED" "BLOCKED" \
  "$(curl -s "$B/api/tasks/$SLICING" -H "Authorization: Bearer $FE_TOK" | j 'print(d["status"])')"

# The PM cannot complete a task: that is the assignee's act.
API=cccccccc-0000-4000-8000-000000000002
API_VER=$(curl -s "$B/api/tasks/$API" -H "Authorization: Bearer $BE_TOK" | j 'print(d["version"])')
PM_DONE=$(curl -s -X POST "$B/api/tasks/$API/transition" -H "Authorization: Bearer $PM_TOK" \
  -H 'Content-Type: application/json' -d "{\"to\":\"DONE\",\"version\":$API_VER}")
check "PM cannot mark In Progress -> Done" "PM_CANNOT_COMPLETE" "$(echo "$PM_DONE" | j 'print(d["error"]["code"])')"

# A non-assignee engineer cannot move someone else's task.
check "non-assignee cannot move task" "NOT_ASSIGNEE" \
  "$(curl -s -X POST "$B/api/tasks/$API/transition" -H "Authorization: Bearer $FE_TOK" \
     -H 'Content-Type: application/json' -d "{\"to\":\"DONE\",\"version\":$API_VER}" | j 'print(d["error"]["code"])')"

# Internal team cannot rewrite the core description.
check "engineer cannot edit description" "INTERNAL_MEMBER_FORBIDDEN" \
  "$(curl -s -X PATCH "$B/api/tasks/$API" -H "Authorization: Bearer $BE_TOK" \
     -H 'Content-Type: application/json' -d "{\"version\":$API_VER,\"description\":\"hacked\"}" | j 'print(d["error"]["code"])')"

# The assignee can complete via review.
curl -s -X POST "$B/api/tasks/$API/transition" -H "Authorization: Bearer $BE_TOK" \
  -H 'Content-Type: application/json' -d "{\"to\":\"IN_REVIEW\",\"version\":$API_VER}" > /dev/null
API_VER=$(curl -s "$B/api/tasks/$API" -H "Authorization: Bearer $BE_TOK" | j 'print(d["version"])')
check "assignee can move In Review -> Done" "DONE" \
  "$(curl -s -X POST "$B/api/tasks/$API/transition" -H "Authorization: Bearer $BE_TOK" \
     -H 'Content-Type: application/json' -d "{\"to\":\"DONE\",\"version\":$API_VER}" | j 'print(d["status"])')"

echo "=== dependency auto-unblock ==="
# Completing the last prerequisite must reconcile the dependent out of BLOCKED.
check "dependent auto-unblocked to TODO" "TODO" \
  "$(curl -s "$B/api/tasks/$SLICING" -H "Authorization: Bearer $FE_TOK" | j 'print(d["status"])')"
check "audit recorded AUTO_UNBLOCKED" "true" \
  "$(curl -s "$B/api/tasks/$SLICING/logs?rows=50" -H "Authorization: Bearer $FE_TOK" \
     | j 'print(str(any(l["action"]=="AUTO_UNBLOCKED" for l in d["data"])).lower())')"

echo "=== optimistic locking ==="
SL_VER=$(curl -s "$B/api/tasks/$SLICING" -H "Authorization: Bearer $FE_TOK" | j 'print(d["version"])')
# Two writers holding the same version: exactly one may win. Firing them
# sequentially is still a valid test of the lock, because the second request
# carries the version it read *before* the first request incremented it.
R1=$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "$B/api/tasks/$SLICING" -H "Authorization: Bearer $PM_TOK" \
  -H 'Content-Type: application/json' -d "{\"version\":$SL_VER,\"title\":\"Race A\"}")
R2=$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "$B/api/tasks/$SLICING" -H "Authorization: Bearer $PM_TOK" \
  -H 'Content-Type: application/json' -d "{\"version\":$SL_VER,\"title\":\"Race B\"}")
check "first writer wins with 200" "200" "$R1"
check "second writer with the same version gets 409" "409" "$R2"
check "conflict reports VERSION_CONFLICT" "VERSION_CONFLICT" \
  "$(curl -s -X PATCH "$B/api/tasks/$SLICING" -H "Authorization: Bearer $PM_TOK" \
     -H 'Content-Type: application/json' -d "{\"version\":$SL_VER,\"title\":\"Race C\"}" | j 'print(d["error"]["code"])')"
check "first writer's value survived" "Race A" \
  "$(curl -s "$B/api/tasks/$SLICING" -H "Authorization: Bearer $FE_TOK" | j 'print(d["title"])')"

echo "=== dependency cycle detection ==="
DESIGN=cccccccc-0000-4000-8000-000000000001
QC=cccccccc-0000-4000-8000-000000000004
check "cycle rejected" "CYCLE_DETECTED" \
  "$(curl -s -X POST "$B/api/tasks/$DESIGN/dependencies" -H "Authorization: Bearer $PM_TOK" \
     -H 'Content-Type: application/json' -d "{\"dependsOnTaskId\":\"$QC\"}" | j 'print(d["error"]["code"])')"

echo "=== attachments ==="
# Files are streamed through a permission-checked route, not served statically.
TMPFILE=$(mktemp)
printf 'handoff notes\n' > "$TMPFILE"
UPLOAD=$(curl -s -X POST "$B/api/tasks/$SLICING/attachments" -H "Authorization: Bearer $PM_TOK" -F "file=@$TMPFILE")
AID=$(echo "$UPLOAD" | j 'print(d["id"])')
AURL=$(echo "$UPLOAD" | j 'print(d["fileUrl"])')
check "upload returns a server-owned url" "/api/attachments/$AID" "$AURL"
check "uploader reported in response" "Rani Prameswari" \
  "$(echo "$UPLOAD" | j 'print((d.get("uploadedBy") or {}).get("name"))')"
check "staff can download it" "handoff notes" \
  "$(curl -s "$B$AURL" -H "Authorization: Bearer $PM_TOK")"
check "download without a session is 401" "401" \
  "$(curl -s -o /dev/null -w '%{http_code}' "$B$AURL")"
check "guest cannot upload" "403" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/tasks/$SLICING/attachments" \
     -H "Authorization: Bearer $CG_TOK" -F "file=@$TMPFILE")"
# A client guest may fetch a file on a task shared with them...
check "guest can download a client-visible attachment" "handoff notes" \
  "$(curl -s "$B$AURL" -H "Authorization: Bearer $CG_TOK")"
# ...but not one on a task that was never shared: 404, not 403, so the
# attachment's existence is not disclosed either.
HIDDEN=cccccccc-0000-4000-8000-000000000006
HID=$(curl -s -X POST "$B/api/tasks/$HIDDEN/attachments" -H "Authorization: Bearer $PM_TOK" -F "file=@$TMPFILE" | j 'print(d["id"])')
check "guest gets 404 for an internal attachment" "404" \
  "$(curl -s -o /dev/null -w '%{http_code}' "$B/api/attachments/$HID" -H "Authorization: Bearer $CG_TOK")"
check "malformed attachment id is a 400" "400" \
  "$(curl -s -o /dev/null -w '%{http_code}' "$B/api/attachments/nope" -H "Authorization: Bearer $PM_TOK")"
rm -f "$TMPFILE"

echo "=== request hygiene ==="
# A client mistake should not be reported as a server fault with a driver
# message attached.
check "malformed task id is a 400" "INVALID_ID" \
  "$(curl -s "$B/api/tasks/not-a-uuid" -H "Authorization: Bearer $PM_TOK" | j 'print(d["error"]["code"])')"
check "unknown task id is a 404" "NOT_FOUND" \
  "$(curl -s "$B/api/tasks/99999999-9999-4999-8999-999999999999" -H "Authorization: Bearer $PM_TOK" | j 'print(d["error"]["code"])')"

echo
printf 'passed=%s failed=%s\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
