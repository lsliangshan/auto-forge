import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type Database from 'better-sqlite3'

const sourceMigrationDirectory = fileURLToPath(new URL('../../../resources/migrations/', import.meta.url))

function migrationDirectory(): string {
  const packagedDirectory = process.resourcesPath ? `${process.resourcesPath}/migrations` : ''
  return packagedDirectory && existsSync(packagedDirectory) ? packagedDirectory : sourceMigrationDirectory
}

export function runMigrations(database: Database.Database): void {
  database.pragma('foreign_keys = ON')
  const migrations = readdirSync(migrationDirectory())
    .map((fileName) => ({ fileName, version: Number.parseInt(fileName.slice(0, 4), 10) }))
    .filter(({ fileName, version }) => fileName.endsWith('.sql') && Number.isInteger(version))
    .sort((left, right) => left.version - right.version)

  for (const migration of migrations) {
    const hasMigrationTable = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get()
    const applied = hasMigrationTable
      ? database.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(migration.version)
      : undefined
    if (applied) continue

    const source = readFileSync(`${migrationDirectory()}/${migration.fileName}`, 'utf8')
    database.transaction(() => {
      database.exec(source)
      database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(migration.version, Date.now())
    })()
  }
}
