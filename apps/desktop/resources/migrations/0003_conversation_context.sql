ALTER TABLE messages ADD COLUMN ordinal INTEGER;

WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY conversation_id
      ORDER BY created_at, rowid
    ) AS ordinal
  FROM messages
)
UPDATE messages
SET ordinal = (SELECT ranked.ordinal FROM ranked WHERE ranked.id = messages.id);

CREATE UNIQUE INDEX messages_conversation_ordinal_idx
  ON messages(conversation_id, ordinal);

CREATE TABLE conversation_contexts (
  conversation_id TEXT PRIMARY KEY
    REFERENCES conversations(id) ON DELETE CASCADE,
  summary_text TEXT NOT NULL,
  through_ordinal INTEGER NOT NULL CHECK (through_ordinal >= 0),
  estimated_tokens INTEGER NOT NULL CHECK (estimated_tokens >= 0),
  updated_at INTEGER NOT NULL
);
