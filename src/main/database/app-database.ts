import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'

export type AppDatabase = {
  path: string
}

type DatabaseConnection = {
  pragma: (statement: string) => unknown
  exec: (statement: string) => unknown
  close: () => void
}

type DatabaseConstructor = new (path: string) => DatabaseConnection

export function ensureAppDatabase(
  databasePath: string,
  DatabaseClient: DatabaseConstructor = Database
): AppDatabase {
  mkdirSync(dirname(databasePath), { recursive: true })

  const db = new DatabaseClient(databasePath)
  try {
    db.pragma('journal_mode = WAL')
    db.exec(`
      create table if not exists schema_migrations (
        version integer primary key,
        applied_at text not null default CURRENT_TIMESTAMP
      )
    `)
  } finally {
    db.close()
  }

  return { path: databasePath }
}
