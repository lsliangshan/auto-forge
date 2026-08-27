import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DesktopAPI } from '@autoforge/shared'
import MessageBlock from '../../src/components/chat/MessageBlock.vue'

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
    const setConsent = vi.fn().mockResolvedValue({ provider: 'deepseek', status: 'granted' })
    const revokeConsent = vi.fn().mockResolvedValue({ provider: 'deepseek', status: 'unknown' })
    window.autoForge = {
      auth: {}, profile: {}, chat: {}, workflows: {}, executions: {}, settings: {},
      knowledge: { setConsent, revokeConsent },
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
    expect(setConsent).toHaveBeenCalledWith('deepseek', 'granted')
    await wrapper.get('[data-testid="revoke-knowledge-consent"]').trigger('click')
    await flushPromises()
    expect(revokeConsent).toHaveBeenCalledWith('deepseek')
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
})
