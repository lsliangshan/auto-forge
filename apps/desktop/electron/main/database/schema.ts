import { foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const schemaMigrations = sqliteTable('schema_migrations', {
  version: integer('version').primaryKey(),
  appliedAt: integer('applied_at').notNull(),
})

export const conversations = sqliteTable('conversations', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (table) => [index('conversations_updated_at_idx').on(table.updatedAt)])

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
  blocksJson: text('blocks_json').notNull(),
  executionId: text('execution_id'),
  createdAt: integer('created_at').notNull(),
}, (table) => [index('messages_conversation_created_at_idx').on(table.conversationId, table.createdAt, table.id)])

export const chatRuns = sqliteTable('chat_runs', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
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
  chatRunId: text('chat_run_id').references(() => chatRuns.id, { onDelete: 'set null' }),
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
