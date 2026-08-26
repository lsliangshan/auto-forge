import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('knowledge Electron smoke production composition', () => {
  it('uses the real Application chat and citation boundary without hand-built messages', async () => {
    const source = await readFile(new URL('./knowledge-ui-smoke-main.ts', import.meta.url), 'utf8')

    expect(source).toContain('createApplicationRuntime')
    expect(source).toContain('runtime.services.chat')
    expect(source).toContain("name: 'knowledge_search'")
    expect(source).toContain("name: 'knowledge_grounded_answer'")
    expect(source).not.toContain('let chatMessages')
    expect(source).not.toContain('previewKnowledgeCitation: async')
    expect(source).not.toContain('new KnowledgeService')
  })
})
