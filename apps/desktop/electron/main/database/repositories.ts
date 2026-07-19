import type Database from 'better-sqlite3'

export interface Conversation {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

export interface Message {
  id: string
  conversationId: string
  role: string
  blocks: unknown[]
  executionId?: string
  createdAt: number
}

export interface ChatRun {
  id: string
  conversationId: string
  requestId: string
  model: string
  status: string
  generationId?: string
  inputTokens?: number
  outputTokens?: number
  costUsd?: string
  errorCode?: string
  startedAt: number
  endedAt?: number
}

export interface WorkflowProject {
  id: string
  name: string
  rootPath: string
  manifest?: unknown
  status: string
  buildHash?: string
  lastError?: string
  createdAt: number
  updatedAt: number
}

export interface InstalledWorkflow {
  workflowId: string
  version: string
  name: string
  description: string
  author: string
  category: string
  manifest: unknown
  installPath: string
  enabled: boolean
  integrityStatus: string
  source: string
  installedAt: number
  updatedAt: number
}

export interface WorkflowFile {
  workflowId: string
  workflowVersion: string
  path: string
  sha256: string
}

export interface Execution {
  id: string
  workflowId: string
  workflowVersion: string
  chatRunId?: string
  status: string
  input: unknown
  result?: unknown
  errorCode?: string
  createdAt: number
  startedAt?: number
  endedAt?: number
}

export interface ExecutionStep {
  id: string
  executionId: string
  sequence: number
  name: string
  status: string
  percent?: number
  startedAt?: number
  endedAt?: number
}

export interface ExecutionLog {
  id: string
  executionId: string
  sequence: number
  level: string
  message: string
  metadata?: unknown
  createdAt: number
}

export interface PermissionGrant {
  id: string
  workflowId: string
  workflowVersion: string
  capability: string
  scope: unknown
  scopeHash: string
  createdAt: number
  updatedAt: number
}

export interface AppSetting {
  key: string
  value: unknown
  updatedAt: number
}

export interface EncryptedSecret {
  key: string
  ciphertextBase64: string
  updatedAt: number
}

type Query = Record<string, unknown>
type SqliteDatabase = Database.Database

function now(): number {
  return Date.now()
}

function parse(value: string | null): unknown | undefined {
  return value === null ? undefined : JSON.parse(value)
}

function transaction<T>(database: SqliteDatabase, operation: () => T): T {
  return database.transaction(operation)()
}

function one<T>(database: SqliteDatabase, sql: string, parameters: Query): T | undefined {
  return database.prepare(sql).get(parameters) as T | undefined
}

function many<T>(database: SqliteDatabase, sql: string, parameters: Query = {}): T[] {
  return database.prepare(sql).all(parameters) as T[]
}

export interface EncryptedSecretsRepository {
  get(key: string): EncryptedSecret | undefined
  set(key: string, ciphertextBase64: string): void
  delete(key: string): void
  raw(key: string): string | undefined
}

export interface AppRepositories {
  conversations: {
    insert(value: Pick<Conversation, 'id' | 'title'> & Partial<Pick<Conversation, 'createdAt' | 'updatedAt'>>): Conversation
    get(id: string): Conversation | undefined
    list(): Conversation[]
    update(id: string, value: Partial<Pick<Conversation, 'title' | 'updatedAt'>>): Conversation | undefined
    delete(id: string): void
  }
  messages: {
    insert(value: Omit<Message, 'executionId'> & { executionId?: string }): Message
    get(id: string): Message | undefined
    listForConversation(conversationId: string): Message[]
    update(id: string, value: Partial<Pick<Message, 'blocks' | 'executionId'>>): Message | undefined
  }
  chatRuns: {
    insert(value: Omit<ChatRun, 'generationId' | 'inputTokens' | 'outputTokens' | 'costUsd' | 'errorCode' | 'endedAt'> & Partial<Pick<ChatRun, 'generationId' | 'inputTokens' | 'outputTokens' | 'costUsd' | 'errorCode' | 'endedAt'>>): ChatRun
    get(id: string): ChatRun | undefined
    update(id: string, value: Partial<Omit<ChatRun, 'id' | 'conversationId' | 'requestId' | 'model' | 'startedAt'>>): ChatRun | undefined
  }
  workflowProjects: { insert(value: WorkflowProject): WorkflowProject; get(id: string): WorkflowProject | undefined; list(): WorkflowProject[]; update(id: string, value: Partial<Omit<WorkflowProject, 'id' | 'createdAt'>>): WorkflowProject | undefined }
  installedWorkflows: { upsert(value: InstalledWorkflow): InstalledWorkflow; get(workflowId: string, version: string): InstalledWorkflow | undefined; list(): InstalledWorkflow[]; setEnabled(workflowId: string, version: string, enabled: boolean): void }
  workflowFiles: { insert(value: WorkflowFile): WorkflowFile; list(workflowId: string, workflowVersion: string): WorkflowFile[] }
  executions: {
    insert(value: Pick<Execution, 'id' | 'status' | 'workflowId' | 'workflowVersion'> & Partial<Omit<Execution, 'id' | 'status' | 'workflowId' | 'workflowVersion'>>): Execution
    get(id: string): Execution | undefined
    update(id: string, value: Partial<Omit<Execution, 'id' | 'workflowId' | 'workflowVersion' | 'createdAt'>>): Execution | undefined
    markInterrupted(): number
  }
  executionSteps: { insert(value: ExecutionStep): ExecutionStep; list(executionId: string): ExecutionStep[] }
  executionLogs: { insert(value: ExecutionLog): ExecutionLog; list(executionId: string): ExecutionLog[] }
  permissionGrants: { upsert(value: PermissionGrant): PermissionGrant; get(workflowId: string, workflowVersion: string, capability: string, scopeHash: string): PermissionGrant | undefined; delete(id: string): void }
  appSettings: { get(key: string): AppSetting | undefined; set(key: string, value: unknown): AppSetting; delete(key: string): void }
  encryptedSecrets: EncryptedSecretsRepository
}

const conversationColumns = 'id, title, created_at AS createdAt, updated_at AS updatedAt'
const messageColumns = 'id, conversation_id AS conversationId, role, blocks_json AS blocksJson, execution_id AS executionId, created_at AS createdAt'
const chatRunColumns = 'id, conversation_id AS conversationId, request_id AS requestId, model, status, generation_id AS generationId, input_tokens AS inputTokens, output_tokens AS outputTokens, cost_usd AS costUsd, error_code AS errorCode, started_at AS startedAt, ended_at AS endedAt'
const projectColumns = 'id, name, root_path AS rootPath, manifest_json AS manifestJson, status, build_hash AS buildHash, last_error AS lastError, created_at AS createdAt, updated_at AS updatedAt'
const installedWorkflowColumns = 'workflow_id AS workflowId, version, name, description, author, category, manifest_json AS manifestJson, install_path AS installPath, enabled, integrity_status AS integrityStatus, source, installed_at AS installedAt, updated_at AS updatedAt'
const executionColumns = 'id, workflow_id AS workflowId, workflow_version AS workflowVersion, chat_run_id AS chatRunId, status, input_json AS inputJson, result_json AS resultJson, error_code AS errorCode, created_at AS createdAt, started_at AS startedAt, ended_at AS endedAt'

function messageFromRow(row: Query): Message {
  return { ...row, blocks: parse(row.blocksJson as string) as unknown[] } as Message
}

function projectFromRow(row: Query): WorkflowProject {
  return { ...row, manifest: parse(row.manifestJson as string | null) } as WorkflowProject
}

function installedWorkflowFromRow(row: Query): InstalledWorkflow {
  return { ...row, enabled: Boolean(row.enabled), manifest: parse(row.manifestJson as string) } as InstalledWorkflow
}

function executionFromRow(row: Query): Execution {
  return { ...row, input: parse(row.inputJson as string), result: parse(row.resultJson as string | null) } as Execution
}

function permissionFromRow(row: Query): PermissionGrant {
  return { ...row, scope: parse(row.scopeJson as string) } as PermissionGrant
}

export function createRepositories(database: SqliteDatabase): AppRepositories {
  return {
    conversations: {
      insert(value) {
        const createdAt = value.createdAt ?? now()
        const updatedAt = value.updatedAt ?? createdAt
        transaction(database, () => database.prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (@id, @title, @createdAt, @updatedAt)').run({ ...value, createdAt, updatedAt }))
        return { id: value.id, title: value.title, createdAt, updatedAt }
      },
      get: (id) => one<Conversation>(database, `SELECT ${conversationColumns} FROM conversations WHERE id = @id`, { id }),
      list: () => many<Conversation>(database, `SELECT ${conversationColumns} FROM conversations ORDER BY updated_at DESC, id`),
      update(id, value) {
        const updatedAt = value.updatedAt ?? now()
        transaction(database, () => database.prepare('UPDATE conversations SET title = COALESCE(@title, title), updated_at = @updatedAt WHERE id = @id').run({ id, title: value.title ?? null, updatedAt }))
        return one<Conversation>(database, `SELECT ${conversationColumns} FROM conversations WHERE id = @id`, { id })
      },
      delete: (id) => { transaction(database, () => database.prepare('DELETE FROM conversations WHERE id = @id').run({ id })) },
    },
    messages: {
      insert(value) {
        transaction(database, () => database.prepare('INSERT INTO messages (id, conversation_id, role, blocks_json, execution_id, created_at) VALUES (@id, @conversationId, @role, @blocksJson, @executionId, @createdAt)').run({ ...value, blocksJson: JSON.stringify(value.blocks), executionId: value.executionId ?? null }))
        return value
      },
      get: (id) => { const row = one<Query>(database, `SELECT ${messageColumns} FROM messages WHERE id = @id`, { id }); return row && messageFromRow(row) },
      listForConversation: (conversationId) => many<Query>(database, `SELECT ${messageColumns} FROM messages WHERE conversation_id = @conversationId ORDER BY created_at, id`, { conversationId }).map(messageFromRow),
      update(id, value) {
        transaction(database, () => database.prepare('UPDATE messages SET blocks_json = COALESCE(@blocksJson, blocks_json), execution_id = COALESCE(@executionId, execution_id) WHERE id = @id').run({ id, blocksJson: value.blocks === undefined ? null : JSON.stringify(value.blocks), executionId: value.executionId ?? null }))
        const row = one<Query>(database, `SELECT ${messageColumns} FROM messages WHERE id = @id`, { id })
        return row && messageFromRow(row)
      },
    },
    chatRuns: {
      insert(value) {
        transaction(database, () => database.prepare('INSERT INTO chat_runs (id, conversation_id, request_id, model, status, generation_id, input_tokens, output_tokens, cost_usd, error_code, started_at, ended_at) VALUES (@id, @conversationId, @requestId, @model, @status, @generationId, @inputTokens, @outputTokens, @costUsd, @errorCode, @startedAt, @endedAt)').run(value))
        return value
      },
      get: (id) => one<ChatRun>(database, `SELECT ${chatRunColumns} FROM chat_runs WHERE id = @id`, { id }),
      update(id, value) {
        transaction(database, () => database.prepare('UPDATE chat_runs SET status = COALESCE(@status, status), generation_id = COALESCE(@generationId, generation_id), input_tokens = COALESCE(@inputTokens, input_tokens), output_tokens = COALESCE(@outputTokens, output_tokens), cost_usd = COALESCE(@costUsd, cost_usd), error_code = COALESCE(@errorCode, error_code), ended_at = COALESCE(@endedAt, ended_at) WHERE id = @id').run({ id, ...value }))
        return one<ChatRun>(database, `SELECT ${chatRunColumns} FROM chat_runs WHERE id = @id`, { id })
      },
    },
    workflowProjects: {
      insert(value) {
        transaction(database, () => database.prepare('INSERT INTO workflow_projects (id, name, root_path, manifest_json, status, build_hash, last_error, created_at, updated_at) VALUES (@id, @name, @rootPath, @manifestJson, @status, @buildHash, @lastError, @createdAt, @updatedAt)').run({ ...value, manifestJson: value.manifest === undefined ? null : JSON.stringify(value.manifest) }))
        return value
      },
      get: (id) => { const row = one<Query>(database, `SELECT ${projectColumns} FROM workflow_projects WHERE id = @id`, { id }); return row && projectFromRow(row) },
      list: () => many<Query>(database, `SELECT ${projectColumns} FROM workflow_projects ORDER BY updated_at DESC, id`).map(projectFromRow),
      update(id, value) {
        transaction(database, () => database.prepare('UPDATE workflow_projects SET name = COALESCE(@name, name), manifest_json = COALESCE(@manifestJson, manifest_json), status = COALESCE(@status, status), build_hash = COALESCE(@buildHash, build_hash), last_error = COALESCE(@lastError, last_error), updated_at = @updatedAt WHERE id = @id').run({ id, ...value, manifestJson: value.manifest === undefined ? null : JSON.stringify(value.manifest), updatedAt: value.updatedAt ?? now() }))
        const row = one<Query>(database, `SELECT ${projectColumns} FROM workflow_projects WHERE id = @id`, { id })
        return row && projectFromRow(row)
      },
    },
    installedWorkflows: {
      upsert(value) {
        transaction(database, () => database.prepare('INSERT INTO installed_workflows (workflow_id, version, name, description, author, category, manifest_json, install_path, enabled, integrity_status, source, installed_at, updated_at) VALUES (@workflowId, @version, @name, @description, @author, @category, @manifestJson, @installPath, @enabled, @integrityStatus, @source, @installedAt, @updatedAt) ON CONFLICT(workflow_id, version) DO UPDATE SET name = excluded.name, description = excluded.description, author = excluded.author, category = excluded.category, manifest_json = excluded.manifest_json, install_path = excluded.install_path, enabled = excluded.enabled, integrity_status = excluded.integrity_status, source = excluded.source, updated_at = excluded.updated_at').run({ ...value, enabled: Number(value.enabled), manifestJson: JSON.stringify(value.manifest) }))
        return value
      },
      get: (workflowId, version) => { const row = one<Query>(database, `SELECT ${installedWorkflowColumns} FROM installed_workflows WHERE workflow_id = @workflowId AND version = @version`, { workflowId, version }); return row && installedWorkflowFromRow(row) },
      list: () => many<Query>(database, `SELECT ${installedWorkflowColumns} FROM installed_workflows ORDER BY name, version`).map(installedWorkflowFromRow),
      setEnabled: (workflowId, version, enabled) => { transaction(database, () => database.prepare('UPDATE installed_workflows SET enabled = @enabled, updated_at = @updatedAt WHERE workflow_id = @workflowId AND version = @version').run({ workflowId, version, enabled: Number(enabled), updatedAt: now() })) },
    },
    workflowFiles: {
      insert(value) { transaction(database, () => database.prepare('INSERT INTO workflow_files (workflow_id, workflow_version, path, sha256) VALUES (@workflowId, @workflowVersion, @path, @sha256)').run(value)); return value },
      list: (workflowId, workflowVersion) => many<WorkflowFile>(database, 'SELECT workflow_id AS workflowId, workflow_version AS workflowVersion, path, sha256 FROM workflow_files WHERE workflow_id = @workflowId AND workflow_version = @workflowVersion ORDER BY path', { workflowId, workflowVersion }),
    },
    executions: {
      insert(value) {
        const createdAt = value.createdAt ?? now()
        const input = value.input ?? {}
        transaction(database, () => database.prepare('INSERT INTO executions (id, workflow_id, workflow_version, chat_run_id, status, input_json, result_json, error_code, created_at, started_at, ended_at) VALUES (@id, @workflowId, @workflowVersion, @chatRunId, @status, @inputJson, @resultJson, @errorCode, @createdAt, @startedAt, @endedAt)').run({ ...value, inputJson: JSON.stringify(input), resultJson: value.result === undefined ? null : JSON.stringify(value.result), chatRunId: value.chatRunId ?? null, errorCode: value.errorCode ?? null, createdAt, startedAt: value.startedAt ?? null, endedAt: value.endedAt ?? null }))
        return { ...value, input, createdAt } as Execution
      },
      get: (id) => { const row = one<Query>(database, `SELECT ${executionColumns} FROM executions WHERE id = @id`, { id }); return row && executionFromRow(row) },
      update(id, value) {
        transaction(database, () => database.prepare('UPDATE executions SET chat_run_id = COALESCE(@chatRunId, chat_run_id), status = COALESCE(@status, status), input_json = COALESCE(@inputJson, input_json), result_json = COALESCE(@resultJson, result_json), error_code = COALESCE(@errorCode, error_code), started_at = COALESCE(@startedAt, started_at), ended_at = COALESCE(@endedAt, ended_at) WHERE id = @id').run({ id, ...value, inputJson: value.input === undefined ? null : JSON.stringify(value.input), resultJson: value.result === undefined ? null : JSON.stringify(value.result) }))
        const row = one<Query>(database, `SELECT ${executionColumns} FROM executions WHERE id = @id`, { id })
        return row && executionFromRow(row)
      },
      markInterrupted: () => transaction(database, () => database.prepare("UPDATE executions SET status = 'interrupted', ended_at = @endedAt WHERE status IN ('pending', 'running', 'waiting_approval')").run({ endedAt: now() }).changes),
    },
    executionSteps: {
      insert(value) { transaction(database, () => database.prepare('INSERT INTO execution_steps (id, execution_id, sequence, name, status, percent, started_at, ended_at) VALUES (@id, @executionId, @sequence, @name, @status, @percent, @startedAt, @endedAt)').run(value)); return value },
      list: (executionId) => many<ExecutionStep>(database, 'SELECT id, execution_id AS executionId, sequence, name, status, percent, started_at AS startedAt, ended_at AS endedAt FROM execution_steps WHERE execution_id = @executionId ORDER BY sequence', { executionId }),
    },
    executionLogs: {
      insert(value) { transaction(database, () => database.prepare('INSERT INTO execution_logs (id, execution_id, sequence, level, message, metadata_json, created_at) VALUES (@id, @executionId, @sequence, @level, @message, @metadataJson, @createdAt)').run({ ...value, metadataJson: value.metadata === undefined ? null : JSON.stringify(value.metadata) })); return value },
      list: (executionId) => many<Query>(database, 'SELECT id, execution_id AS executionId, sequence, level, message, metadata_json AS metadataJson, created_at AS createdAt FROM execution_logs WHERE execution_id = @executionId ORDER BY sequence', { executionId }).map((row) => ({ ...row, metadata: parse(row.metadataJson as string | null) } as ExecutionLog)),
    },
    permissionGrants: {
      upsert(value) {
        transaction(database, () => database.prepare('INSERT INTO permission_grants (id, workflow_id, workflow_version, capability, scope_json, scope_hash, created_at, updated_at) VALUES (@id, @workflowId, @workflowVersion, @capability, @scopeJson, @scopeHash, @createdAt, @updatedAt) ON CONFLICT(workflow_id, workflow_version, capability, scope_hash) DO UPDATE SET updated_at = excluded.updated_at').run({ ...value, scopeJson: JSON.stringify(value.scope) }))
        return value
      },
      get: (workflowId, workflowVersion, capability, scopeHash) => { const row = one<Query>(database, 'SELECT id, workflow_id AS workflowId, workflow_version AS workflowVersion, capability, scope_json AS scopeJson, scope_hash AS scopeHash, created_at AS createdAt, updated_at AS updatedAt FROM permission_grants WHERE workflow_id = @workflowId AND workflow_version = @workflowVersion AND capability = @capability AND scope_hash = @scopeHash', { workflowId, workflowVersion, capability, scopeHash }); return row && permissionFromRow(row) },
      delete: (id) => { transaction(database, () => database.prepare('DELETE FROM permission_grants WHERE id = @id').run({ id })) },
    },
    appSettings: {
      get: (key) => { const row = one<Query>(database, 'SELECT key, value_json AS valueJson, updated_at AS updatedAt FROM app_settings WHERE key = @key', { key }); return row && { key: row.key as string, value: parse(row.valueJson as string), updatedAt: row.updatedAt as number } },
      set(key, value) {
        const updatedAt = now()
        transaction(database, () => database.prepare('INSERT INTO app_settings (key, value_json, updated_at) VALUES (@key, @valueJson, @updatedAt) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at').run({ key, valueJson: JSON.stringify(value), updatedAt }))
        return { key, value, updatedAt }
      },
      delete: (key) => { transaction(database, () => database.prepare('DELETE FROM app_settings WHERE key = @key').run({ key })) },
    },
    encryptedSecrets: {
      get: (key) => one<EncryptedSecret>(database, 'SELECT key, ciphertext_base64 AS ciphertextBase64, updated_at AS updatedAt FROM encrypted_secrets WHERE key = @key', { key }),
      set(key, ciphertextBase64) { transaction(database, () => database.prepare('INSERT INTO encrypted_secrets (key, ciphertext_base64, updated_at) VALUES (@key, @ciphertextBase64, @updatedAt) ON CONFLICT(key) DO UPDATE SET ciphertext_base64 = excluded.ciphertext_base64, updated_at = excluded.updated_at').run({ key, ciphertextBase64, updatedAt: now() })) },
      delete: (key) => { transaction(database, () => database.prepare('DELETE FROM encrypted_secrets WHERE key = @key').run({ key })) },
      raw: (key) => one<{ ciphertextBase64: string }>(database, 'SELECT ciphertext_base64 AS ciphertextBase64 FROM encrypted_secrets WHERE key = @key', { key })?.ciphertextBase64,
    },
  }
}
