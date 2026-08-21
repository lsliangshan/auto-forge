CREATE TABLE local_user_roles (
  user_id TEXT PRIMARY KEY REFERENCES local_users(id) ON DELETE CASCADE,
  role TEXT NOT NULL
    CHECK (
      length(role) BETWEEN 1 AND 63
      AND role GLOB '[a-z]*'
      AND role NOT GLOB '*[^a-z0-9_]*'
    ),
  version INTEGER NOT NULL CHECK (version >= 0),
  cloud_updated_at INTEGER NOT NULL,
  synced_at INTEGER NOT NULL
);
