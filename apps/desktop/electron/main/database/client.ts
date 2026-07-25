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

  const recoverInterrupted = () => sqlite.transaction(() => {
    const endedAt = Date.now()
    const executions = sqlite.prepare("UPDATE executions SET status = 'interrupted', error_code = 'INTERNAL_ERROR', ended_at = ? WHERE status IN ('queued', 'awaiting_approval', 'running', 'pending', 'waiting_approval')").run(endedAt).changes
    const chatRuns = sqlite.prepare(`
      UPDATE chat_runs
      SET status = 'failed', error_code = 'INTERNAL_ERROR', ended_at = ?
      WHERE status IN ('queued', 'awaiting_approval', 'running', 'streaming')
        AND NOT EXISTS (
          SELECT 1
          FROM media_generation_jobs
          WHERE media_generation_jobs.id = chat_runs.request_id
            AND media_generation_jobs.status IN ('pending', 'in_progress', 'downloading', 'paused')
        )
    `).run(endedAt).changes
    repositories.messages.failInterruptedMediaGenerations()
    return { executions, chatRuns }
  })()

  const clearConversations = () => sqlite.transaction(() => {
    sqlite.prepare('DELETE FROM conversations').run()
  })()

  const clearLocalData = (scope: 'conversations' | 'executions' | 'all') => sqlite.transaction(() => {
    if (scope === 'executions' || scope === 'all') sqlite.prepare('DELETE FROM executions').run()
    if (scope === 'conversations' || scope === 'all') sqlite.prepare('DELETE FROM conversations').run()
  })()

  return {
    db,
    close: () => sqlite.close(),
    schemaVersion: () => (sqlite.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null }).version ?? 0,
    markInterruptedExecutions: () => repositories.executions.markInterrupted(),
    recoverInterrupted,
    clearConversations,
    clearLocalData,
    ...repositories,
  }
}
