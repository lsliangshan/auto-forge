import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DesktopAPI } from '@autoforge/shared'
import MessageBlock from '../../src/components/chat/MessageBlock.vue'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('knowledge grounding blocks', () => {
  afterEach(() => Reflect.deleteProperty(window, 'autoForge'))

  it('renders the bounded search status and a local source preview', async () => {
    const status = mount(MessageBlock, {
      props: { block: {
        id: 'message:status', type: 'knowledge_status', blockId: 'status', status: 'found',
        searchIndex: 2, searchLimit: 3, evidenceCount: 1,
      } },
      global: { plugins: [ElementPlus] },
    })
    expect(status.get('[data-testid="knowledge-status"]').text()).toContain('已找到 1 条依据')
    expect(status.text()).toContain('第 2 次检索 · 上限 3 次')

    const getSourcePreview = vi.fn().mockResolvedValue({ kind: 'available', preview: '合同经双方签字后生效。' })
    window.autoForge = {
      auth: {}, profile: {}, chat: {}, workflows: {}, executions: {}, settings: {},
      knowledge: { getSourcePreview },
    } as unknown as DesktopAPI
    const citation = mount(MessageBlock, {
      props: { block: {
        id: 'message:citation', type: 'knowledge_citation', blockId: 'citation',
        evidenceId: 'evidence:1', baseId: 'base_1', documentId: 'document_1', versionId: 'version_1',
        coordinate: { kind: 'text', line: 8, startOffset: 0, endOffset: 6 },
      } },
      global: { plugins: [ElementPlus] },
    })
    expect(citation.get('[data-testid="knowledge-citation"]').text()).toContain('第 8 行')
    await citation.get('[data-testid="toggle-knowledge-preview"]').trigger('click')
    await flushPromises()
    expect(citation.get('[data-testid="knowledge-source-preview"]').text()).toContain('合同经双方签字后生效。')
    expect(getSourcePreview).toHaveBeenCalledWith(expect.objectContaining({
      evidenceId: 'evidence:1', baseId: 'base_1', documentId: 'document_1', versionId: 'version_1',
    }))
  })

  it('records and revokes Provider-bound consent through the real desktop bridge action', async () => {
    const getConsent = vi.fn().mockResolvedValue({ provider: 'deepseek', status: 'unknown' })
    const setConsent = vi.fn().mockResolvedValue({ provider: 'deepseek', status: 'granted' })
    const revokeConsent = vi.fn().mockResolvedValue({ provider: 'deepseek', status: 'unknown' })
    window.autoForge = {
      auth: {}, profile: {}, chat: {}, workflows: {}, executions: {}, settings: {},
      knowledge: { getConsent, setConsent, revokeConsent },
    } as unknown as DesktopAPI
    const wrapper = mount(MessageBlock, {
      props: { block: {
        id: 'message:status', type: 'knowledge_status', blockId: 'status', status: 'consent_required',
        searchIndex: 1, searchLimit: 3, evidenceCount: 1, provider: 'deepseek',
      } },
      global: { plugins: [ElementPlus] },
    })
    await flushPromises()
    expect(getConsent).toHaveBeenCalledWith('deepseek')
    await wrapper.get('[data-testid="grant-knowledge-consent"]').trigger('click')
    await flushPromises()
    expect(setConsent).toHaveBeenCalledWith('deepseek', 'granted')
    await wrapper.get('[data-testid="revoke-knowledge-consent"]').trigger('click')
    await flushPromises()
    expect(revokeConsent).toHaveBeenCalledWith('deepseek')
  })

  it('presents Provider consent as a structured authorization panel', async () => {
    window.autoForge = {
      auth: {}, profile: {}, chat: {}, workflows: {}, executions: {}, settings: {},
      knowledge: {
        getConsent: vi.fn().mockResolvedValue({ provider: 'deepseek', status: 'unknown' }),
        setConsent: vi.fn(), revokeConsent: vi.fn(),
      },
    } as unknown as DesktopAPI
    const wrapper = mount(MessageBlock, {
      props: { block: {
        id: 'message:status', type: 'knowledge_status', blockId: 'status', status: 'consent_required',
        searchIndex: 1, searchLimit: 3, evidenceCount: 1, provider: 'deepseek',
      } },
      global: { plugins: [ElementPlus] },
    })
    await flushPromises()

    expect(wrapper.get('[data-testid="knowledge-consent-badge"]').text()).toBe('待授权')
    expect(wrapper.get('[data-testid="knowledge-consent-panel"]').text()).toContain('DeepSeek')
    expect(wrapper.get('[data-testid="grant-knowledge-consent"]').classes()).toContain('el-button--primary')
    expect(wrapper.get('[data-testid="deny-knowledge-consent"]').classes()).toContain('el-button')
  })

  it('restores Provider consent on remount, refreshes on switch, and exposes sanitized failures', async () => {
    const getConsent = vi.fn()
      .mockResolvedValueOnce({ provider: 'deepseek', status: 'granted' })
      .mockRejectedValueOnce(new Error('secret /etc/private'))
    window.autoForge = {
      auth: {}, profile: {}, chat: {}, workflows: {}, executions: {}, settings: {},
      knowledge: { getConsent, setConsent: vi.fn(), revokeConsent: vi.fn() },
    } as unknown as DesktopAPI
    const wrapper = mount(MessageBlock, {
      props: { block: {
        id: 'message:status', type: 'knowledge_status', blockId: 'status', status: 'consent_required',
        searchIndex: 1, searchLimit: 3, evidenceCount: 1, provider: 'deepseek',
      } },
      global: { plugins: [ElementPlus] },
    })
    await flushPromises()
    expect(wrapper.text()).toContain('已授权当前模型供应商')
    expect(wrapper.find('[data-testid="revoke-knowledge-consent"]').exists()).toBe(true)

    await wrapper.setProps({ block: {
      id: 'message:status', type: 'knowledge_status', blockId: 'status', status: 'consent_required',
      searchIndex: 1, searchLimit: 3, evidenceCount: 1, provider: 'openrouter',
    } })
    await flushPromises()
    expect(getConsent).toHaveBeenLastCalledWith('openrouter')
    expect(wrapper.get('[data-testid="knowledge-consent-error"]').attributes('aria-live')).toBe('polite')
    expect(wrapper.text()).toContain('无法读取当前授权状态')
    expect(wrapper.text()).not.toContain('/etc/private')
  })

  it('does not let an older consent read overwrite a completed grant', async () => {
    const oldRead = deferred<{ provider: 'deepseek'; status: 'unknown' }>()
    const setConsent = vi.fn().mockResolvedValue({ provider: 'deepseek', status: 'granted' })
    window.autoForge = {
      auth: {}, profile: {}, chat: {}, workflows: {}, executions: {}, settings: {},
      knowledge: {
        getConsent: vi.fn(() => oldRead.promise), setConsent, revokeConsent: vi.fn(),
      },
    } as unknown as DesktopAPI
    const wrapper = mount(MessageBlock, {
      props: { block: {
        id: 'message:status', type: 'knowledge_status', blockId: 'status', status: 'consent_required',
        searchIndex: 1, searchLimit: 3, evidenceCount: 1, provider: 'deepseek',
      } },
      global: { plugins: [ElementPlus] },
    })

    await wrapper.get('[data-testid="grant-knowledge-consent"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('已授权，请重新发送问题')
    oldRead.resolve({ provider: 'deepseek', status: 'unknown' })
    await flushPromises()
    expect(wrapper.find('[data-testid="revoke-knowledge-consent"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="grant-knowledge-consent"]').exists()).toBe(false)
  })

  it('keeps a switched Provider isolated from an older pending grant', async () => {
    const grant = deferred<{ provider: 'deepseek'; status: 'granted' }>()
    const getConsent = vi.fn()
      .mockResolvedValueOnce({ provider: 'deepseek', status: 'unknown' })
      .mockResolvedValueOnce({ provider: 'openrouter', status: 'unknown' })
    const setConsent = vi.fn(() => grant.promise)
    window.autoForge = {
      auth: {}, profile: {}, chat: {}, workflows: {}, executions: {}, settings: {},
      knowledge: { getConsent, setConsent, revokeConsent: vi.fn() },
    } as unknown as DesktopAPI
    const wrapper = mount(MessageBlock, {
      props: { block: {
        id: 'message:status', type: 'knowledge_status', blockId: 'status', status: 'consent_required',
        searchIndex: 1, searchLimit: 3, evidenceCount: 1, provider: 'deepseek',
      } },
      global: { plugins: [ElementPlus] },
    })
    await flushPromises()
    await wrapper.get('[data-testid="grant-knowledge-consent"]').trigger('click')
    expect(setConsent).toHaveBeenCalledWith('deepseek', 'granted')

    await wrapper.setProps({ block: {
      id: 'message:status', type: 'knowledge_status', blockId: 'status', status: 'consent_required',
      searchIndex: 1, searchLimit: 3, evidenceCount: 1, provider: 'openrouter',
    } })
    await flushPromises()
    grant.resolve({ provider: 'deepseek', status: 'granted' })
    await flushPromises()

    expect(getConsent).toHaveBeenLastCalledWith('openrouter')
    expect(wrapper.find('[data-testid="grant-knowledge-consent"]').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('已授权，请重新发送问题')
  })

  it('fails a missing source closed without exposing stale preview text', async () => {
    window.autoForge = {
      auth: {}, profile: {}, chat: {}, workflows: {}, executions: {}, settings: {},
      knowledge: { getSourcePreview: vi.fn().mockResolvedValue({ kind: 'unavailable' }) },
    } as unknown as DesktopAPI
    const wrapper = mount(MessageBlock, {
      props: { block: {
        id: 'message:citation', type: 'knowledge_citation', blockId: 'citation',
        evidenceId: 'evidence:1', baseId: 'base_1', documentId: 'document_1', versionId: 'version_1',
        coordinate: { kind: 'pdf', page: 3, startOffset: 1, endOffset: 9 },
      } },
      global: { plugins: [ElementPlus] },
    })
    await wrapper.get('[data-testid="toggle-knowledge-preview"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('来源当前不可用')
  })

  it('renders an upgraded legacy citation as unavailable without requesting its old preview', () => {
    const getSourcePreview = vi.fn()
    window.autoForge = {
      auth: {}, profile: {}, chat: {}, workflows: {}, executions: {}, settings: {},
      knowledge: { getSourcePreview },
    } as unknown as DesktopAPI
    const wrapper = mount(MessageBlock, {
      props: { block: {
        id: 'message:legacy', type: 'knowledge_citation', blockId: 'legacy',
        evidenceId: 'evidence:legacy', baseId: 'legacy_unavailable',
        documentId: 'document_legacy', versionId: 'version_legacy', legacyUnavailable: true,
        coordinate: { kind: 'text', line: 3, startOffset: 0, endOffset: 6 },
      } },
      global: { plugins: [ElementPlus] },
    })
    expect(wrapper.text()).toContain('来源当前不可用')
    expect(wrapper.find('[data-testid="toggle-knowledge-preview"]').exists()).toBe(false)
    expect(getSourcePreview).not.toHaveBeenCalled()
  })
})
