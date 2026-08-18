CREATE TABLE local_user_profiles (
  user_id TEXT PRIMARY KEY REFERENCES local_users(id) ON DELETE CASCADE,
  avatar_url TEXT,
  display_name TEXT,
  gender TEXT,
  birth_date TEXT,
  email TEXT,
  phone TEXT,
  updated_at INTEGER NOT NULL
);
