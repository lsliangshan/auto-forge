import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { openAppDatabase } from './client.js'

const temporaryDirectories: string[] = []

function openTestDatabase() {
  const directory = mkdtempSync(join(tmpdir(), 'autoforge-database-'))
  temporaryDirectories.push(directory)
  return openAppDatabase(join(directory, 'autoforge.sqlite'))
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('openAppDatabase', () => {
  it('packages migrations where the migration runner resolves them', () => {
    const configPath = fileURLToPath(new URL('../../../electron-builder.yml', import.meta.url))
    const config = readFileSync(configPath, 'utf8')

    expect(config).toContain('extraResources:\n  - from: resources/migrations\n    to: migrations')
  })

  it('migrates a fresh database and interrupts abandoned executions', () => {
    const database = openTestDatabase()

    database.executions.insert({
      id: 'exec_1',
      status: 'running',
      workflowId: 'w',
      workflowVersion: '1.0.0',
    })

    expect(database.schemaVersion()).toBe(1)
    expect(database.executions.markInterrupted()).toBe(1)
    expect(database.executions.get('exec_1')?.status).toBe('interrupted')
  })

  it('persists JSON message blocks in chronological order and cascades deletion', () => {
    const database = openTestDatabase()
    database.conversations.insert({ id: 'conversation_1', title: 'First conversation' })
    database.messages.insert({
      id: 'message_1',
      conversationId: 'conversation_1',
      role: 'user',
      blocks: [{ type: 'text', text: 'first' }],
      createdAt: 10,
    })
    database.messages.insert({
      id: 'message_2',
      conversationId: 'conversation_1',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'second' }],
      createdAt: 20,
    })

    expect(database.messages.listForConversation('conversation_1').map((message) => message.id))
      .toEqual(['message_1', 'message_2'])

    database.conversations.delete('conversation_1')
    expect(database.messages.listForConversation('conversation_1')).toEqual([])
  })

  it('atomically commits assistant partials with the chat-run terminal state', () => {
    const database = openTestDatabase()
    database.conversations.insert({ id: 'conversation_terminal', title: 'Terminal' })
    database.messages.insert({
      id: 'assistant_terminal', conversationId: 'conversation_terminal', role: 'assistant',
      blocks: [{ type: 'text', text: '部分' }], createdAt: 1,
    })
    database.chatRuns.insert({
      id: 'run_terminal', conversationId: 'conversation_terminal', requestId: 'request_terminal',
      model: 'model', status: 'running', startedAt: 1,
    })

    database.chatRuns.finalizeWithMessage('run_terminal', 'assistant_terminal', {
      blocks: [{ type: 'text', text: '完整' }], status: 'completed', endedAt: 2,
      generationId: 'generation_1', inputTokens: 3, outputTokens: 4, costUsd: '0.01',
    })

    expect(database.messages.get('assistant_terminal')?.blocks).toEqual([{ type: 'text', text: '完整' }])
    expect(database.chatRuns.get('run_terminal')).toMatchObject({
      status: 'completed', endedAt: 2, generationId: 'generation_1', inputTokens: 3, outputTokens: 4, costUsd: '0.01',
    })

    expect(() => database.chatRuns.finalizeWithMessage('missing', 'assistant_terminal', {
      blocks: [{ type: 'text', text: '不得提交' }], status: 'failed', endedAt: 3,
    })).toThrow()
    expect(database.messages.get('assistant_terminal')?.blocks).toEqual([{ type: 'text', text: '完整' }])
  })

  it('redacts execution log text and metadata before persistence', () => {
    const database = openTestDatabase()
    database.executions.insert({
      id: 'execution_1',
      status: 'running',
      workflowId: 'workflow_1',
      workflowVersion: '1.0.0',
    })
    database.executionLogs.insert({
      id: 'log_1',
      executionId: 'execution_1',
      sequence: 1,
      level: 'info',
      message: JSON.stringify({ apiKey: 'api-secret', input: { privateValue: 'private-secret' } }),
      metadata: { accessToken: 'token-secret', input: { privateValue: 'private-secret' } },
      sensitivePaths: ['input.privateValue'],
      createdAt: 1,
    })

    const stored = database.executionLogs.list('execution_1')[0]
    expect(JSON.stringify(stored)).not.toContain('api-secret')
    expect(JSON.stringify(stored)).not.toContain('token-secret')
    expect(JSON.stringify(stored)).not.toContain('private-secret')
    expect(stored.message).toContain('[REDACTED]')
  })

  it('redacts complete plain-text secret values before persistence and return', () => {
    const database = openTestDatabase()
    database.executions.insert({ id: 'execution_2', status: 'running', workflowId: 'workflow_1', workflowVersion: '1.0.0' })
    const message = 'Authorization: Bearer sk-secret; X-API-Key: api-secret; token=token-secret; password=password-secret'
    const returned = database.executionLogs.insert({
      id: 'log_2',
      executionId: 'execution_2',
      sequence: 1,
      level: 'info',
      message,
      sensitivePaths: ['credentials.password'],
      createdAt: 1,
    })
    const stored = database.executionLogs.list('execution_2')[0]

    for (const secret of ['sk-secret', 'api-secret', 'token-secret', 'password-secret']) {
      expect(returned.message).not.toContain(secret)
      expect(stored.message).not.toContain(secret)
    }
    expect(stored.message).toContain('[REDACTED]')
  })
})
