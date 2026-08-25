ALTER TABLE executions ADD COLUMN owner_user_id TEXT;

CREATE INDEX executions_owner_created_at_idx
  ON executions(owner_user_id, created_at DESC, id);

CREATE TRIGGER executions_require_owner_on_insert
BEFORE INSERT ON executions
WHEN NEW.owner_user_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'execution owner required');
END;
