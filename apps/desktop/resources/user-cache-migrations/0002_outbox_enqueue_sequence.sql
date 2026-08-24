ALTER TABLE outbox_mutations ADD COLUMN enqueue_sequence INTEGER;

UPDATE outbox_mutations
SET enqueue_sequence = rowid;

CREATE TABLE outbox_enqueue_counter (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  value INTEGER NOT NULL CHECK (value >= 0)
);

INSERT INTO outbox_enqueue_counter (id, value)
SELECT 1, COALESCE(MAX(enqueue_sequence), 0)
FROM outbox_mutations;

CREATE UNIQUE INDEX outbox_enqueue_sequence_unique
  ON outbox_mutations(enqueue_sequence);

DROP INDEX outbox_ready_idx;
CREATE INDEX outbox_ready_idx
  ON outbox_mutations(state, next_attempt_at, enqueue_sequence);
