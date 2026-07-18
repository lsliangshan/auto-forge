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
  }
]
