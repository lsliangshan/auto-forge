import { describe, expect, it } from 'vitest'
import type { BrowserContinuationBinding } from '../browser/browser-continuation-types.js'
import { BrowserContinuationCatalog } from './browser-continuation-catalog.js'

function binding(overrides: Partial<BrowserContinuationBinding> = {}): BrowserContinuationBinding {
  return {
    bindingId: 'binding_1',
    tabId: 'tab_private_1',
    userId: 'user_1',
    conversationId: 'conversation_1',
    chatRunId: 'originating_run_private',
    executionId: 'execution_private',
    workflowId: 'permit.query',
    workflowVersion: '1.2.3',
    source: 'installed',
    securityFingerprint: 'a'.repeat(64),
    permissionMatrix: { 'browser.open': ['https://permit.example.gov.cn/private/*'] },
    createdAt: 100,
    status: 'active',
    ...overrides,
  }
}

function harness() {
  const bindings = [
    binding(),
    binding({
      bindingId: 'binding_2', tabId: 'tab_private_2', workflowId: 'permit.renew',
      workflowVersion: '2.0.0', createdAt: 200,
    }),
    binding({ bindingId: 'other_conversation', conversationId: 'conversation_2' }),
    binding({ bindingId: 'other_user', userId: 'user_2' }),
  ]
  const descriptions = new Map([
    ['binding_1', {
      workflowLabel: '证件查询', pageLabel: '证件详情',
      origin: 'https://permit.example.gov.cn', lastActiveAt: 1_775_520_000_000,
    }],
    ['binding_2', {
      workflowLabel: '证件续期', pageLabel: '续期表单',
      origin: 'https://renew.example.gov.cn', lastActiveAt: 1_775_520_001_000,
    }],
  ])
  const catalog = new BrowserContinuationCatalog({
    registry: {
      // The catalog defends its own authority boundary even if an adapter returns an over-broad list.
      list: () => bindings,
    },
    describe: async (candidate) => descriptions.get(candidate.bindingId),
  })
  return { catalog, bindings, descriptions }
}

describe('BrowserContinuationCatalog', () => {
  it('offers live bindings only to their exact user and conversation', async () => {
    const { catalog } = harness()

    const own = await catalog.create({ userId: 'user_1', conversationId: 'conversation_1' })
    const otherConversation = await catalog.create({ userId: 'user_1', conversationId: 'conversation_3' })
    const otherUser = await catalog.create({ userId: 'user_3', conversationId: 'conversation_1' })

    expect([...own.bindings.keys()]).toEqual(['binding_1', 'binding_2'])
    expect(own.tools.map((tool) => tool.function.name)).toEqual([
      'browser_session_inspect', 'browser_session_act', 'browser_session_handoff',
    ])
    expect(otherConversation.tools).toEqual([])
    expect(otherUser.tools).toEqual([])
  })

  it('deep-freezes a safe admission snapshot without private binding authority', async () => {
    const { catalog, bindings, descriptions } = harness()

    const snapshot = await catalog.create({ userId: 'user_1', conversationId: 'conversation_1' })
    ;(bindings[0] as { workflowVersion: string }).workflowVersion = '9.9.9'
    descriptions.get('binding_1')!.pageLabel = '被篡改的标题'
    const serialized = JSON.stringify(snapshot.tools)

    expect(snapshot.bindings.get('binding_1')).toEqual({
      bindingId: 'binding_1', workflowLabel: '证件查询', workflowVersion: '1.2.3',
      pageLabel: '证件详情', origin: 'https://permit.example.gov.cn', lastActiveAt: 1_775_520_000_000,
    })
    expect(serialized).toContain('binding_1')
    expect(serialized).toContain('binding_2')
    expect(serialized).not.toMatch(/tab_private|originating_run_private|execution_private|securityFingerprint|permissionMatrix|private\/\*/)
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.tools)).toBe(true)
    expect(Object.isFrozen(snapshot.tools[0]!.function)).toBe(true)
    expect(Object.isFrozen(snapshot.bindings.get('binding_1'))).toBe(true)
    expect('set' in snapshot.bindings).toBe(false)
  })

  it('omits a binding whose current safe page description is unavailable or invalid', async () => {
    const { catalog, descriptions } = harness()
    descriptions.delete('binding_1')
    descriptions.set('binding_2', {
      workflowLabel: '证件续期', pageLabel: '续期表单',
      origin: 'https://renew.example.gov.cn/path?token=secret', lastActiveAt: 1_775_520_001_000,
    })

    const snapshot = await catalog.create({ userId: 'user_1', conversationId: 'conversation_1' })

    expect(snapshot.bindings.size).toBe(0)
    expect(snapshot.tools).toEqual([])
  })
})
