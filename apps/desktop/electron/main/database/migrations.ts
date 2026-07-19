import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type Database from 'better-sqlite3'

export function resolveMigrationDirectory(moduleUrl = import.meta.url, packagedResourcesPath = process.resourcesPath): string {
  const candidates = [
    packagedResourcesPath ? `${packagedResourcesPath}/migrations` : '',
    fileURLToPath(new URL('../../../resources/migrations/', moduleUrl)),
    fileURLToPath(new URL('../../resources/migrations/', moduleUrl)),
  ]
  const directory = candidates.find((candidate) => candidate && existsSync(candidate))
  if (!directory) throw new Error('Database migrations are unavailable')
  return directory
}

export function runMigrations(database: Database.Database): void {
  database.pragma('foreign_keys = ON')
  const migrationDirectory = resolveMigrationDirectory()
  const migrations = readdirSync(migrationDirectory)
    .map((fileName) => ({ fileName, version: Number.parseInt(fileName.slice(0, 4), 10) }))
    .filter(({ fileName, version }) => fileName.endsWith('.sql') && Number.isInteger(version))
    .sort((left, right) => left.version - right.version)

  for (const migration of migrations) {
    const hasMigrationTable = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get()
    const applied = hasMigrationTable
      ? database.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(migration.version)
      : undefined
    if (applied) continue

    const source = readFileSync(`${migrationDirectory}/${migration.fileName}`, 'utf8')
    database.transaction(() => {
      database.exec(source)
      database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(migration.version, Date.now())
    })()
  }
}
