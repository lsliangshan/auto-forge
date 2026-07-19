export interface Migration {
  version: number
  sql: string
}

export const migrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS installed_tools (
        tool_id TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        installed_at TEXT NOT NULL
      );
    `
  },
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS workflow_projects (
        id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, slug TEXT NOT NULL, name TEXT NOT NULL,
        version TEXT NOT NULL, status TEXT NOT NULL, code_sha256 TEXT, build_error TEXT, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS installed_workflows (
        workflow_id TEXT PRIMARY KEY, slug TEXT NOT NULL, version TEXT NOT NULL,
        install_path TEXT NOT NULL, manifest_json TEXT NOT NULL, installed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS encrypted_sessions (
        id INTEGER PRIMARY KEY CHECK (id = 1), encrypted_refresh_token TEXT NOT NULL,
        user_json TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `
  }
]
