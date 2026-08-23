import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatEvent } from '@autoforge/shared'
import { openAppDatabase } from '../database/client.js'
import type { ModelProvider, ModelStreamRequest } from './model-provider.js'
import { ConversationTitleService } from './conversation-title-service.js'

const temporaryDirectories: string[] = []

function createHarness(stream: ModelProvider['stream']) {
  const directory = mkdtempSync(join(tmpdir(), 'autoforge-conversation-title-'))
  temporaryDirectories.push(directory)
  const database = openAppDatabase(join(directory, 'autoforge.sqlite'))
  database.conversations.insert({
    id: 'conversation_1',
    title: '新会话',
    titleState: 'pending',
  })
  database.messages.insert({
    id: 'user_1', conversationId: 'conversation_1', role: 'user',
    blocks: [{ type: 'text', text: '我想办理北京工作居住证' }], createdAt: 1,
  })
  database.messages.insert({
    id: 'assistant_1', conversationId: 'conversation_1', role: 'assistant',
    blocks: [{ type: 'text', text: '我可以帮你查询办理条件和所需材料。' }], createdAt: 2,
  })
  const events: ChatEvent[] = []
  const service = new ConversationTitleService({
    repositories: database,
    emit: (event) => events.push(event),
    id: () => 'title_usage_1',
    now: () => 10,
  })
  const provider: ModelProvider = {
    listModels: async () => [],
    validateCredential: async () => ({ valid: true }),
    stream,
  }
  return { database, events, provider, service }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('ConversationTitleService', () => {
  it('names a pending conversation once from the first completed turn', async () => {
    let request: ModelStreamRequest | undefined
    const harness = createHarness(async function* (input) {
      request = input
      yield { type: 'text_delta', choiceIndex: 0, text: '“北京工作居住证办理”\n' }
      yield { type: 'finish', choiceIndex: 0, reason: 'stop' }
    })

    await expect(harness.service.generate({
      conversationId: 'conversation_1', userId: 'user_1', requestId: 'request_1',
      providerSnapshot: { providerId: 'deepseek', provider: harness.provider },
      model: 'deepseek-v4-flash',
    })).resolves.toMatchObject({ title: '北京工作居住证办理', titleState: 'ai_named' })

    expect(request).toMatchObject({
      model: 'deepseek-v4-flash',
      maxOutputTokens: 64,
      endUserId: 'user_1',
    })
    expect(JSON.stringify(request?.messages)).toContain('我想办理北京工作居住证')
    expect(JSON.stringify(request?.messages)).toContain('我可以帮你查询办理条件和所需材料')
    expect(harness.events).toEqual([{
      type: 'conversation_title_updated',
      conversationId: 'conversation_1',
      title: '北京工作居住证办理',
      updatedAt: new Date(harness.database.conversations.get('conversation_1')!.updatedAt).toISOString(),
    }])

    await expect(harness.service.generate({
      conversationId: 'conversation_1', userId: 'user_1', requestId: 'request_2',
      providerSnapshot: { providerId: 'deepseek', provider: harness.provider },
      model: 'deepseek-v4-flash',
    })).resolves.toBeUndefined()
  })

  it('does not overwrite a manual rename that wins while generation is running', async () => {
    let release: (() => void) | undefined
    const waiting = new Promise<void>((resolve) => { release = resolve })
    const harness = createHarness(async function* () {
      await waiting
      yield { type: 'text_delta', choiceIndex: 0, text: 'AI 标题' }
      yield { type: 'finish', choiceIndex: 0, reason: 'stop' }
    })

    const generation = harness.service.generate({
      conversationId: 'conversation_1', userId: 'user_1', requestId: 'request_1',
      providerSnapshot: { providerId: 'deepseek', provider: harness.provider },
      model: 'deepseek-v4-flash',
    })
    await vi.waitFor(() => {
      expect(harness.database.conversations.get('conversation_1')?.titleState).toBe('generating')
    })
    harness.database.conversations.renameByUser('conversation_1', '用户自己的名称')
    release!()

    await expect(generation).resolves.toBeUndefined()
    expect(harness.database.conversations.get('conversation_1')).toMatchObject({
      title: '用户自己的名称', titleState: 'user_named',
    })
    expect(harness.events).toEqual([])
  })

  it('marks an invalid generation failed and never retries it', async () => {
    const stream = vi.fn(async function* () {
      yield { type: 'finish' as const, choiceIndex: 0, reason: 'length' }
    })
    const harness = createHarness(stream)
    const input = {
      conversationId: 'conversation_1', userId: 'user_1', requestId: 'request_1',
      providerSnapshot: { providerId: 'deepseek' as const, provider: harness.provider },
      model: 'deepseek-v4-flash',
    }

    await expect(harness.service.generate(input)).resolves.toBeUndefined()
    await expect(harness.service.generate(input)).resolves.toBeUndefined()
    expect(stream).toHaveBeenCalledTimes(1)
    expect(harness.database.conversations.get('conversation_1')).toMatchObject({
      title: '新会话', titleState: 'failed',
    })
    expect(harness.events).toEqual([])
  })

  it('bounds the repeated conversation content sent to the title model', async () => {
    let request: ModelStreamRequest | undefined
    const harness = createHarness(async function* (input) {
      request = input
      yield { type: 'text_delta', choiceIndex: 0, text: '长对话标题' }
      yield { type: 'finish', choiceIndex: 0, reason: 'stop' }
    })
    harness.database.messages.update('user_1', {
      blocks: [{ type: 'text', text: `开头${'甲'.repeat(10_000)}用户末尾` }],
    })
    harness.database.messages.update('assistant_1', {
      blocks: [{ type: 'text', text: `回复${'乙'.repeat(10_000)}助手末尾` }],
    })

    await harness.service.generate({
      conversationId: 'conversation_1', userId: 'user_1', requestId: 'request_1',
      providerSnapshot: { providerId: 'deepseek', provider: harness.provider },
      model: 'deepseek-v4-flash',
    })

    const serialized = JSON.stringify(request?.messages)
    expect(serialized).toContain('开头')
    expect(serialized).not.toContain('用户末尾')
    expect(serialized).not.toContain('助手末尾')
    expect(Array.from(serialized).length).toBeLessThan(5_000)
  })
})
