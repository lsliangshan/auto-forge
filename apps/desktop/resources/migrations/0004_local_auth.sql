CREATE TABLE local_users (
  id TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  account_normalized TEXT NOT NULL UNIQUE,
  password_digest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE local_auth_session (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  user_id TEXT NOT NULL REFERENCES local_users(id) ON DELETE CASCADE,
  authenticated_at INTEGER NOT NULL
);
