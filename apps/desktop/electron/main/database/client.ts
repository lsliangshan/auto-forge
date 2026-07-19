import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { runMigrations } from './migrations.js'
import { createRepositories } from './repositories.js'
import * as schema from './schema.js'

export function openAppDatabase(path: string) {
  const sqlite = new Database(path)
  sqlite.pragma('foreign_keys = ON')
  runMigrations(sqlite)

  const db = drizzle(sqlite, { schema })
  const repositories = createRepositories(sqlite)

  return {
    db,
    close: () => sqlite.close(),
    schemaVersion: () => (sqlite.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null }).version ?? 0,
    markInterruptedExecutions: () => repositories.executions.markInterrupted(),
    ...repositories,
  }
}
