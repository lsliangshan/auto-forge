import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { toSafeAppError } from '@autoforge/shared'
import { runMigrations } from './migrations.js'
import { createCloudBaseIdentityRepository } from './cloudbase-identity-repository.js'
import { createLocalAuthRepository } from './local-auth-repository.js'
import { createUserProfileRepository } from './user-profile-repository.js'
import { createRepositories, type AppRepositories } from './repositories.js'
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
  const legacyReadOnly = (): never => {
    throw toSafeAppError({ code: 'CONFLICT' })
  }
  const legacyConversations: AppRepositories['conversations'] = {
    ...repositories.conversations,
    insert: legacyReadOnly,
    claimLegacyAndListForUser: legacyReadOnly,
    renameByUser: legacyReadOnly,
    claimTitleGeneration: legacyReadOnly,
    completeTitleGeneration: legacyReadOnly,
    failTitleGeneration: legacyReadOnly,
    failPendingTitleGeneration: legacyReadOnly,
    failInterruptedTitleGenerations: legacyReadOnly,
    updateGenerationPreferences: legacyReadOnly,
    delete: legacyReadOnly,
  }
  const legacyMessages: AppRepositories['messages'] = {
    ...repositories.messages,
    insert: legacyReadOnly,
    insertWithAssets: legacyReadOnly,
    update: legacyReadOnly,
    replaceBlock: legacyReadOnly,
    upgradeLegacyApprovals: legacyReadOnly,
    invalidatePendingAgentApprovals: legacyReadOnly,
    failInterruptedMediaGenerations: legacyReadOnly,
    failInterruptedBrowserStatuses: legacyReadOnly,
  }
  const legacyConversationContexts: AppRepositories['conversationContexts'] = {
    ...repositories.conversationContexts,
    advance: legacyReadOnly,
  }
  const legacyChatRuns: AppRepositories['chatRuns'] = {
    ...repositories.chatRuns,
    insert: legacyReadOnly,
    startMediaGeneration: legacyReadOnly,
    update: legacyReadOnly,
    finalizeWithMessage: legacyReadOnly,
  }
  const legacyProviderUsage: AppRepositories['providerUsage'] = {
    ...repositories.providerUsage,
    start: legacyReadOnly,
    bindIdentity: legacyReadOnly,
    report: legacyReadOnly,
    markUnknown: legacyReadOnly,
    recoverPending: () => 0,
    listReconcilable: () => [],
    recordReconcileFailure: legacyReadOnly,
  }

  const recoverInterrupted = () => sqlite.transaction(() => {
    const endedAt = Date.now()
    repositories.browserTabBindings.markActiveStale(endedAt)
    const executions = sqlite.prepare("UPDATE executions SET status = 'interrupted', error_code = 'INTERNAL_ERROR', ended_at = ? WHERE status IN ('queued', 'awaiting_approval', 'running', 'pending', 'waiting_approval')").run(endedAt).changes
    return { executions, chatRuns: 0 }
  })()

  const clearConversations = legacyReadOnly

  const clearLocalData = (scope: 'conversations' | 'executions' | 'all') => {
    if (scope !== 'executions') legacyReadOnly()
    return sqlite.transaction(() => {
      sqlite.prepare('DELETE FROM executions').run()
    })()
  }

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
    conversations: legacyConversations,
    messages: legacyMessages,
    conversationContexts: legacyConversationContexts,
    chatRuns: legacyChatRuns,
    providerUsage: legacyProviderUsage,
  }
}
