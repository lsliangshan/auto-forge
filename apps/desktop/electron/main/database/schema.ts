import { sql } from 'drizzle-orm'
import { check, foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const schemaMigrations = sqliteTable('schema_migrations', {
  version: integer('version').primaryKey(),
  appliedAt: integer('applied_at').notNull(),
})

export const conversations = sqliteTable('conversations', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  titleState: text('title_state', {
    enum: ['pending', 'generating', 'ai_named', 'user_named', 'failed'],
  }).notNull().default('user_named'),
  userId: text('user_id').references(() => localUsers.id),
  generationPreferencesJson: text('generation_preferences_json'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (table) => [
  index('conversations_updated_at_idx').on(table.updatedAt),
  index('idx_conversations_user_updated_at').on(table.userId, table.updatedAt),
])

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
  blocksJson: text('blocks_json').notNull(),
  executionId: text('execution_id'),
  createdAt: integer('created_at').notNull(),
}, (table) => [index('messages_conversation_created_at_idx').on(table.conversationId, table.createdAt, table.id)])

export const agentWorkflowApprovals = sqliteTable('agent_workflow_approvals', {
  executionId: text('execution_id').primaryKey(),
  messageId: text('message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
  blockId: text('block_id').notNull(),
})

export const mediaAssets = sqliteTable('media_assets', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  messageId: text('message_id').references(() => messages.id, { onDelete: 'set null' }),
  source: text('source').notNull(),
  kind: text('kind').notNull(),
  mimeType: text('mime_type'),
  originalName: text('original_name').notNull(),
  relativePath: text('relative_path'),
  byteSize: integer('byte_size'),
  width: integer('width'),
  height: integer('height'),
  durationMs: integer('duration_ms'),
  sha256: text('sha256'),
  provider: text('provider'),
  model: text('model'),
  status: text('status').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (table) => [
  index('media_assets_conversation_status_idx').on(table.conversationId, table.status, table.createdAt),
  index('media_assets_unclaimed_idx').on(table.messageId, table.createdAt),
])

export const mediaGenerationJobs = sqliteTable('media_generation_jobs', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  assistantMessageId: text('assistant_message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  kind: text('kind').notNull(),
  providerJobId: text('provider_job_id').notNull(),
  status: text('status').notNull(),
  parametersJson: text('parameters_json').notNull(),
  nextPollAt: integer('next_poll_at'),
  pollAttempts: integer('poll_attempts').notNull(),
  errorCode: text('error_code'),
  assetId: text('asset_id').references(() => mediaAssets.id, { onDelete: 'set null' }),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  endedAt: integer('ended_at'),
}, (table) => [index('media_generation_jobs_resume_idx').on(table.status, table.nextPollAt)])

export const chatRuns = sqliteTable('chat_runs', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  userId: text('user_id').references(() => localUsers.id),
  provider: text('provider'),
  requestId: text('request_id').notNull().unique(),
  model: text('model').notNull(),
  status: text('status').notNull(),
  generationId: text('generation_id'),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  costUsd: text('cost_usd'),
  errorCode: text('error_code'),
  startedAt: integer('started_at').notNull(),
  endedAt: integer('ended_at'),
}, (table) => [
  index('chat_runs_conversation_started_at_idx').on(table.conversationId, table.startedAt),
  index('chat_runs_status_idx').on(table.status, table.startedAt),
  index('idx_chat_runs_user_started_at').on(table.userId, table.startedAt),
  check('chat_runs_provider_check', sql`${table.provider} IS NULL OR ${table.provider} IN ('deepseek', 'openrouter')`),
])

export const workflowProjects = sqliteTable('workflow_projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  rootPath: text('root_path').notNull().unique(),
  manifestJson: text('manifest_json'),
  status: text('status').notNull(),
  buildHash: text('build_hash'),
  lastError: text('last_error'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (table) => [index('workflow_projects_status_idx').on(table.status, table.updatedAt)])

export const installedWorkflows = sqliteTable('installed_workflows', {
  workflowId: text('workflow_id').notNull(),
  version: text('version').notNull(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  author: text('author').notNull(),
  category: text('category').notNull(),
  manifestJson: text('manifest_json').notNull(),
  installPath: text('install_path').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull(),
  integrityStatus: text('integrity_status').notNull(),
  source: text('source').notNull(),
  installedAt: integer('installed_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.workflowId, table.version] }),
  index('installed_workflows_enabled_integrity_idx').on(table.enabled, table.integrityStatus),
])

export const workflowFiles = sqliteTable('workflow_files', {
  workflowId: text('workflow_id').notNull(),
  workflowVersion: text('workflow_version').notNull(),
  path: text('path').notNull(),
  sha256: text('sha256').notNull(),
}, (table) => [
  primaryKey({ columns: [table.workflowId, table.workflowVersion, table.path] }),
  foreignKey({
    columns: [table.workflowId, table.workflowVersion],
    foreignColumns: [installedWorkflows.workflowId, installedWorkflows.version],
  }).onDelete('cascade'),
  index('workflow_files_workflow_idx').on(table.workflowId, table.workflowVersion),
])

export const executions = sqliteTable('executions', {
  id: text('id').primaryKey(),
  workflowId: text('workflow_id').notNull(),
  workflowVersion: text('workflow_version').notNull(),
  chatRunId: text('chat_run_id'),
  status: text('status').notNull(),
  inputJson: text('input_json').notNull(),
  resultJson: text('result_json'),
  errorCode: text('error_code'),
  createdAt: integer('created_at').notNull(),
  startedAt: integer('started_at'),
  endedAt: integer('ended_at'),
}, (table) => [
  index('executions_status_created_at_idx').on(table.status, table.createdAt),
  index('executions_created_at_idx').on(table.createdAt),
])

export const executionSteps = sqliteTable('execution_steps', {
  id: text('id').primaryKey(),
  executionId: text('execution_id').notNull().references(() => executions.id, { onDelete: 'cascade' }),
  sequence: integer('sequence').notNull(),
  name: text('name').notNull(),
  status: text('status').notNull(),
  percent: integer('percent'),
  startedAt: integer('started_at'),
  endedAt: integer('ended_at'),
}, (table) => [
  uniqueIndex('execution_steps_execution_sequence_unique').on(table.executionId, table.sequence),
  index('execution_steps_execution_sequence_idx').on(table.executionId, table.sequence),
])

export const executionLogs = sqliteTable('execution_logs', {
  id: text('id').primaryKey(),
  executionId: text('execution_id').notNull().references(() => executions.id, { onDelete: 'cascade' }),
  sequence: integer('sequence').notNull(),
  level: text('level').notNull(),
  message: text('message').notNull(),
  metadataJson: text('metadata_json'),
  createdAt: integer('created_at').notNull(),
}, (table) => [
  uniqueIndex('execution_logs_execution_sequence_unique').on(table.executionId, table.sequence),
  index('execution_logs_execution_sequence_idx').on(table.executionId, table.sequence),
])

export const permissionGrants = sqliteTable('permission_grants', {
  id: text('id').primaryKey(),
  workflowId: text('workflow_id').notNull(),
  workflowVersion: text('workflow_version').notNull(),
  capability: text('capability').notNull(),
  scopeJson: text('scope_json').notNull(),
  scopeHash: text('scope_hash').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (table) => [
  uniqueIndex('permission_grants_lookup_unique').on(table.workflowId, table.workflowVersion, table.capability, table.scopeHash),
  index('permission_grants_lookup_idx').on(table.workflowId, table.workflowVersion, table.capability, table.scopeHash),
])

export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  valueJson: text('value_json').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export const encryptedSecrets = sqliteTable('encrypted_secrets', {
  key: text('key').primaryKey(),
  ciphertextBase64: text('ciphertext_base64').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export const localUsers = sqliteTable('local_users', {
  id: text('id').primaryKey(),
  account: text('account').notNull(),
  accountNormalized: text('account_normalized').notNull(),
  passwordDigest: text('password_digest').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (table) => [uniqueIndex('local_users_account_normalized_unique').on(table.accountNormalized)])

export const localUserProfiles = sqliteTable('local_user_profiles', {
  userId: text('user_id').primaryKey().references(() => localUsers.id, { onDelete: 'cascade' }),
  avatarUrl: text('avatar_url'),
  displayName: text('display_name'),
  gender: text('gender'),
  birthDate: text('birth_date'),
  email: text('email'),
  phone: text('phone'),
  updatedAt: integer('updated_at').notNull(),
})

export const providerUsageEvents = sqliteTable('provider_usage_events', {
  id: text('id').primaryKey(),
  operationKey: text('operation_key').notNull().unique(),
  userId: text('user_id').notNull().references(() => localUsers.id),
  provider: text('provider').notNull(),
  apiKeyFingerprint: text('api_key_fingerprint'),
  requestId: text('request_id').notNull(),
  chatRunId: text('chat_run_id'),
  generationId: text('generation_id'),
  providerJobId: text('provider_job_id'),
  model: text('model').notNull(),
  modality: text('modality').notNull(),
  status: text('status').notNull(),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  costUsd: text('cost_usd'),
  reconcileAttempts: integer('reconcile_attempts').notNull().default(0),
  nextReconcileAt: integer('next_reconcile_at'),
  startedAt: integer('started_at').notNull(),
  endedAt: integer('ended_at'),
}, (table) => [
  uniqueIndex('idx_provider_usage_generation_unique')
    .on(table.generationId)
    .where(sql`${table.generationId} IS NOT NULL`),
  index('idx_provider_usage_user_provider_started').on(table.userId, table.provider, table.startedAt),
  index('idx_provider_usage_reconcile').on(table.status, table.nextReconcileAt),
  check('provider_usage_provider_check', sql`${table.provider} IN ('deepseek', 'openrouter')`),
  check('provider_usage_modality_check', sql`${table.modality} IN ('text', 'image', 'audio', 'video')`),
  check('provider_usage_status_check', sql`${table.status} IN ('pending', 'reported', 'unknown')`),
  check('provider_usage_input_tokens_check', sql`${table.inputTokens} IS NULL OR ${table.inputTokens} >= 0`),
  check('provider_usage_output_tokens_check', sql`${table.outputTokens} IS NULL OR ${table.outputTokens} >= 0`),
  check('provider_usage_reconcile_attempts_check', sql`${table.reconcileAttempts} >= 0`),
  check('provider_usage_cost_status_check', sql`
    (${table.status} = 'reported' AND ${table.costUsd} IS NOT NULL)
    OR (${table.status} IN ('pending', 'unknown') AND ${table.costUsd} IS NULL)
  `),
])

export const localAuthSession = sqliteTable('local_auth_session', {
  id: integer('id').primaryKey(),
  userId: text('user_id').notNull().references(() => localUsers.id, { onDelete: 'cascade' }),
  authenticatedAt: integer('authenticated_at').notNull(),
})

export const localUserRoles = sqliteTable('local_user_roles', {
  userId: text('user_id').primaryKey().references(() => localUsers.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
  version: integer('version').notNull(),
  cloudUpdatedAt: integer('cloud_updated_at').notNull(),
  syncedAt: integer('synced_at').notNull(),
}, (table) => [
  check('local_user_roles_role_check', sql`
    length(${table.role}) BETWEEN 1 AND 63
    AND ${table.role} GLOB '[a-z]*'
    AND ${table.role} NOT GLOB '*[^a-z0-9_]*'
  `),
  check('local_user_roles_version_check', sql`${table.version} >= 0`),
])

export const browserTabBindings = sqliteTable('browser_tab_bindings', {
  id: text('id').primaryKey(),
  tabId: text('tab_id').notNull(),
  userId: text('user_id').notNull().references(() => localUsers.id, { onDelete: 'cascade' }),
  conversationId: text('conversation_id').notNull(),
  chatRunId: text('chat_run_id'),
  executionId: text('execution_id').references(() => executions.id, { onDelete: 'set null' }),
  workflowId: text('workflow_id').notNull(),
  workflowVersion: text('workflow_version').notNull(),
  source: text('source').notNull(),
  buildHash: text('build_hash'),
  securityFingerprint: text('security_fingerprint').notNull(),
  permissionMatrixJson: text('permission_matrix_json').notNull(),
  status: text('status').notNull(),
  terminalReason: text('terminal_reason'),
  createdAt: integer('created_at').notNull(),
  endedAt: integer('ended_at'),
}, (table) => [
  index('browser_tab_bindings_conversation_status_idx').on(table.conversationId, table.status, table.createdAt),
])

export const browserActionAudits = sqliteTable('browser_action_audits', {
  id: text('id').primaryKey(),
  bindingId: text('binding_id').notNull().references(() => browserTabBindings.id, { onDelete: 'cascade' }),
  chatRunId: text('chat_run_id'),
  sequence: integer('sequence').notNull(),
  origin: text('origin').notNull(),
  action: text('action').notNull(),
  targetSummary: text('target_summary').notNull(),
  risk: text('risk').notNull(),
  outcome: text('outcome').notNull(),
  errorCode: text('error_code'),
  createdAt: integer('created_at').notNull(),
}, (table) => [
  uniqueIndex('browser_action_audits_binding_sequence_unique').on(table.bindingId, table.sequence),
  index('browser_action_audits_binding_sequence_idx').on(table.bindingId, table.sequence),
])
