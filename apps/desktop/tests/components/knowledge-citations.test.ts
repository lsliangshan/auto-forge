import { mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { describe, expect, it } from 'vitest'
import MessageBlock from '../../src/components/chat/MessageBlock.vue'

describe('knowledge grounding blocks', () => {
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

    const citation = mount(MessageBlock, {
      props: { block: {
        id: 'message:citation', type: 'knowledge_citation', blockId: 'citation',
        evidenceId: 'evidence:1', documentId: 'document_1', versionId: 'version_1',
        coordinate: { kind: 'text', line: 8, startOffset: 0, endOffset: 6 },
        preview: '合同经双方签字后生效。', sourceAvailable: true,
      } },
      global: { plugins: [ElementPlus] },
    })
    expect(citation.get('[data-testid="knowledge-citation"]').text()).toContain('第 8 行')
    await citation.get('[data-testid="toggle-knowledge-preview"]').trigger('click')
    expect(citation.get('[data-testid="knowledge-source-preview"]').text()).toContain('合同经双方签字后生效。')
  })

  it('fails a missing source closed without exposing stale preview text', () => {
    const wrapper = mount(MessageBlock, {
      props: { block: {
        id: 'message:citation', type: 'knowledge_citation', blockId: 'citation',
        evidenceId: 'evidence:1', documentId: 'document_1', versionId: 'version_1',
        coordinate: { kind: 'pdf', page: 3, startOffset: 1, endOffset: 9 },
        preview: '不可继续展示的旧内容', sourceAvailable: false,
      } },
      global: { plugins: [ElementPlus] },
    })
    expect(wrapper.text()).toContain('来源当前不可用')
    expect(wrapper.text()).not.toContain('不可继续展示的旧内容')
    expect(wrapper.find('[data-testid="toggle-knowledge-preview"]').exists()).toBe(false)
  })
})
