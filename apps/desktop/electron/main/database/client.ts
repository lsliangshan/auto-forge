import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { runMigrations } from './migrations.js'
import { createCloudBaseIdentityRepository } from './cloudbase-identity-repository.js'
import { createLocalAuthRepository } from './local-auth-repository.js'
import { createUserProfileRepository } from './user-profile-repository.js'
import { createRepositories } from './repositories.js'
import * as schema from './schema.js'

export function openAppDatabase(path: string) {
  const sqlite = new Database(path)
  sqlite.pragma('foreign_keys = ON')
  runMigrations(sqlite)

  const db = drizzle(sqlite, { schema })
  const repositories = createRepositories(sqlite)
  const localAuth = createLocalAuthRepository(sqlite)
  const userProfiles = createUserProfileRepository(sqlite)
  const cloudBaseIdentities = createCloudBaseIdentityRepository(sqlite)
  repositories.messages.upgradeLegacyApprovals()

  const recoverInterrupted = () => sqlite.transaction(() => {
    const endedAt = Date.now()
    repositories.browserTabBindings.markActiveStale(endedAt)
    const executions = sqlite.prepare("UPDATE executions SET status = 'interrupted', error_code = 'INTERNAL_ERROR', ended_at = ? WHERE status IN ('queued', 'awaiting_approval', 'running', 'pending', 'waiting_approval')").run(endedAt).changes
    const preservedRequestIds = new Set(
      repositories.mediaGenerationJobs.reconcileInterrupted(endedAt),
    )
    let chatRuns = 0
    const interruptedRuns = sqlite.prepare(`
      SELECT id, request_id AS requestId
      FROM chat_runs
      WHERE status IN ('queued', 'awaiting_approval', 'running', 'streaming')
    `).all() as Array<{ id: string; requestId: string }>
    const failRun = sqlite.prepare(`
      UPDATE chat_runs
      SET status = 'failed', error_code = 'INTERNAL_ERROR', ended_at = @endedAt
      WHERE id = @id
        AND status IN ('queued', 'awaiting_approval', 'running', 'streaming')
    `)
    const failedRequestIds: string[] = []
    for (const run of interruptedRuns) {
      if (preservedRequestIds.has(run.requestId)) continue
      const changes = failRun.run({ id: run.id, endedAt }).changes
      chatRuns += changes
      if (changes === 1) failedRequestIds.push(run.requestId)
    }
    repositories.messages.failInterruptedBrowserStatuses(failedRequestIds)
    repositories.messages.invalidatePendingAgentApprovals()
    repositories.messages.failInterruptedMediaGenerations()
    repositories.conversations.failInterruptedTitleGenerations()
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
    localAuth,
    userProfiles,
    cloudBaseIdentities,
    close: () => sqlite.close(),
    schemaVersion: () => (sqlite.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null }).version ?? 0,
    markInterruptedExecutions: () => repositories.executions.markInterrupted(),
    recoverInterrupted,
    clearConversations,
    clearLocalData,
    ...repositories,
  }
}
