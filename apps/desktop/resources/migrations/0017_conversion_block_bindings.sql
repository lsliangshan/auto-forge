CREATE TABLE conversion_block_bindings (
  owner_user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  finalized_at INTEGER,
  PRIMARY KEY (owner_user_id, execution_id),
  UNIQUE (owner_user_id, message_id, block_id),
  CHECK (finalized_at IS NULL OR finalized_at >= 0)
);

CREATE INDEX conversion_block_bindings_owner_finalized_idx
  ON conversion_block_bindings(owner_user_id, finalized_at, execution_id);
