ALTER TABLE conversations ADD COLUMN user_id TEXT REFERENCES local_users(id);

CREATE INDEX idx_conversations_user_updated_at
  ON conversations(user_id, updated_at DESC);
