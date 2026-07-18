import { DatabaseSync } from 'node:sqlite'
import { migrations } from './migrations'

export class AppDatabase {
  private readonly database: DatabaseSync

  constructor(path: string) {
    this.database = new DatabaseSync(path)
  }

  initialize(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `)

    const currentVersion = this.database
      .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')
      .get() as { version: number }

    for (const migration of migrations.filter(({ version }) => version > currentVersion.version)) {
      this.database.exec('BEGIN')
      try {
        this.database.exec(migration.sql)
        this.database
          .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
          .run(migration.version, new Date().toISOString())
        this.database.exec('COMMIT')
      } catch (error) {
        this.database.exec('ROLLBACK')
        throw error
      }
    }
  }

  listTableNames(): string[] {
    return (
      this.database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as Array<{ name: string }>
    ).map(({ name }) => name)
  }

  getSetting(key: string): string | undefined {
    const row = this.database.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value
  }

  setSetting(key: string, value: string): void {
    this.database
      .prepare(
        `INSERT INTO app_settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(key, value)
  }

  markToolInstalled(toolId: string, version: string, installedAt: string): void {
    this.database
      .prepare(
        `INSERT INTO installed_tools (tool_id, version, installed_at) VALUES (?, ?, ?)
         ON CONFLICT(tool_id) DO UPDATE SET version = excluded.version, installed_at = excluded.installed_at`
      )
      .run(toolId, version, installedAt)
  }

  listInstalledToolIds(): string[] {
    return (
      this.database.prepare('SELECT tool_id FROM installed_tools ORDER BY installed_at DESC').all() as Array<{
        tool_id: string
      }>
    ).map(({ tool_id }) => tool_id)
  }

  close(): void {
    this.database.close()
  }
}
