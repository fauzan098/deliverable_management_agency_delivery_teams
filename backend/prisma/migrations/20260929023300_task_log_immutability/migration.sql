-- Immutable audit trail.
--
-- Application-level guards (service code that only ever calls .create()) can be
-- bypassed by a future refactor, a script, or a psql session. The audit trail
-- is only credible if the database itself refuses to rewrite history, so the
-- guarantee is pushed down into Postgres as a BEFORE UPDATE OR DELETE trigger.
--
-- ON DELETE CASCADE from the parent task/project is intentionally NOT blocked:
-- a hard cascade drop of the owning row still empties the table. Soft delete is
-- mandatory in this codebase (see prisma/soft-delete extension), so a cascade
-- can only ever fire from an out-of-band destructive action, which the
-- revoked/hard-delete guard in the service layer also refuses.

CREATE OR REPLACE FUNCTION task_logs_reject_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'TaskLog is append-only: % on task_logs is not permitted. Record a compensating entry instead.',
    TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER task_logs_append_only
  BEFORE UPDATE OR DELETE ON "task_logs"
  FOR EACH ROW
  EXECUTE FUNCTION task_logs_reject_mutation();

-- Also block TRUNCATE, which bypasses row-level triggers entirely.
CREATE OR REPLACE FUNCTION task_logs_reject_truncate()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'TaskLog is append-only: TRUNCATE on task_logs is not permitted.'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER task_logs_no_truncate
  BEFORE TRUNCATE ON "task_logs"
  FOR EACH STATEMENT
  EXECUTE FUNCTION task_logs_reject_truncate();
