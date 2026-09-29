-- Re-assert the append-only guarantee on task_logs.
--
-- The original immutability migration (20260929023300) was recorded as applied
-- on this database, but the triggers were not actually present — most likely it
-- was marked applied with `migrate resolve` rather than executed. The audit
-- trail is only credible if the database enforces it, so rather than editing an
-- already-applied migration (which would break its checksum), this migration
-- installs the guard idempotently. It is a no-op on a database where the
-- original migration did run.
--
-- Postgres 14+ supports CREATE OR REPLACE TRIGGER, which is what makes this
-- safe to re-run.

CREATE OR REPLACE FUNCTION task_logs_reject_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'TaskLog is append-only: % on task_logs is not permitted. Record a compensating entry instead.',
    TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER task_logs_append_only
  BEFORE UPDATE OR DELETE ON "task_logs"
  FOR EACH ROW
  EXECUTE FUNCTION task_logs_reject_mutation();

-- TRUNCATE bypasses row-level triggers entirely, so it needs its own statement
-- trigger.
CREATE OR REPLACE FUNCTION task_logs_reject_truncate()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'TaskLog is append-only: TRUNCATE on task_logs is not permitted.'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER task_logs_no_truncate
  BEFORE TRUNCATE ON "task_logs"
  FOR EACH STATEMENT
  EXECUTE FUNCTION task_logs_reject_truncate();
