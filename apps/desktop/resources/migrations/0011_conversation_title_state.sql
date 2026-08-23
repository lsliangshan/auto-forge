ALTER TABLE conversations
  ADD COLUMN title_state TEXT NOT NULL DEFAULT 'user_named'
  CHECK (title_state IN ('pending', 'generating', 'ai_named', 'user_named', 'failed'));
