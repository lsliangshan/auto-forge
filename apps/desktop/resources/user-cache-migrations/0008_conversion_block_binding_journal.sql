CREATE TABLE conversion_block_bindings (
  owner_user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  block_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  finalized_at INTEGER,
  consumed_at INTEGER,
  retired_at INTEGER,
  retirement_reason TEXT,
  PRIMARY KEY (owner_user_id, execution_id),
  UNIQUE (owner_user_id, message_id, block_id),
  UNIQUE (owner_user_id, message_id, execution_id),
  CHECK (length(owner_user_id) BETWEEN 1 AND 512),
  CHECK (length(conversation_id) BETWEEN 1 AND 128),
  CHECK (length(message_id) BETWEEN 1 AND 128),
  CHECK (length(block_id) BETWEEN 1 AND 128),
  CHECK (length(execution_id) BETWEEN 1 AND 128),
  CHECK (finalized_at IS NULL OR finalized_at >= 0),
  CHECK (consumed_at IS NULL OR consumed_at >= 0),
  CHECK (retired_at IS NULL OR retired_at >= 0),
  CHECK (
    (retired_at IS NULL AND retirement_reason IS NULL)
    OR (
      retired_at IS NOT NULL
      AND retirement_reason IN ('missing_execution', 'missing_message', 'invalid_binding')
    )
  ),
  CHECK (consumed_at IS NULL OR finalized_at IS NOT NULL),
  CHECK (consumed_at IS NULL OR retired_at IS NULL)
);

CREATE INDEX conversion_block_bindings_recovery_idx
  ON conversion_block_bindings(owner_user_id, finalized_at, execution_id)
  WHERE consumed_at IS NULL AND retired_at IS NULL;
