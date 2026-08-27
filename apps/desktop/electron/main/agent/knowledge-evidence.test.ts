import { describe, expect, it } from 'vitest'
import type { KnowledgeEvidence } from '@autoforge/shared'
import {
  CurrentTurnKnowledgeEvidence,
  formatValidatedKnowledgeAnswer,
  parseKnowledgeSearchArguments,
  validateKnowledgeAnswer,
} from './knowledge-evidence.js'

function evidence(index: number, overrides: Partial<KnowledgeEvidence> = {}): KnowledgeEvidence {
  const id = `evidence:${index}`
  return {
    id,
    baseId: 'base_selected',
    documentId: `document_${index}`,
    versionId: `version_${index}`,
    snippet: `第 ${index} 条证据`,
    score: 1,
    citation: {
      evidenceId: id,
      documentId: `document_${index}`,
      versionId: `version_${index}`,
      coordinate: { kind: 'text', line: index + 1, startOffset: 0, endOffset: 8 },
    },
    ...overrides,
  }
}

describe('CurrentTurnKnowledgeEvidence', () => {
  it('caps an immutable current-turn registry at eight unique evidence items across searches', () => {
    const registry = new CurrentTurnKnowledgeEvidence(['base_selected'])
    registry.add(Array.from({ length: 6 }, (_, index) => evidence(index)))
    registry.add(Array.from({ length: 6 }, (_, index) => evidence(index + 4)))

    const snapshot = registry.snapshot()
    expect(snapshot).toHaveLength(8)
    expect(snapshot.map(item => item.id)).toEqual(Array.from({ length: 8 }, (_, index) => `evidence:${index}`))
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot[0])).toBe(true)
  })

  it('rejects retriever evidence outside the Main-captured base scope', () => {
    const registry = new CurrentTurnKnowledgeEvidence(['base_selected'])
    expect(() => registry.add([evidence(0, { baseId: 'base_forged' })])).toThrow('Knowledge evidence escaped selected scope')
    expect(registry.snapshot()).toEqual([])
    expect(() => registry.add([evidence(1, {
      id: `evidence:${'x'.repeat(600)}`,
      citation: {
        evidenceId: `evidence:${'x'.repeat(600)}`,
        documentId: 'document_1', versionId: 'version_1',
        coordinate: { kind: 'text', line: 1, startOffset: 0, endOffset: 1 },
      },
    })])).toThrow('Knowledge evidence identity is invalid')
  })

  it('builds a bounded untrusted Provider envelope without owner, path, URL, or generation fields', () => {
    const registry = new CurrentTurnKnowledgeEvidence(['base_selected'])
    registry.add([evidence(0, {
      snippet: '正文 https://signed.example/object?token=private /Users/alice/private.txt /etc/passwd /opt/autoforge \\\\server\\share\\secret.txt C:\\Users\\alice\\private.txt',
      citation: {
        evidenceId: 'evidence:0', documentId: 'document_0', versionId: 'version_0',
        coordinate: { kind: 'docx', headingPath: ['https://signed.example/title'], paragraph: 1 },
      },
    })])

    const envelope = registry.providerEnvelope(registry.snapshot())
    expect(envelope).toContain('UNTRUSTED_KNOWLEDGE_EVIDENCE')
    expect(envelope).toContain('evidence:0')
    expect(envelope).toContain('正文')
    expect(envelope).toContain('[REDACTED_LOCATION]')
    expect(envelope).not.toContain('signed.example')
    expect(envelope).not.toContain('/Users/alice')
    expect(envelope).not.toContain('/etc/passwd')
    expect(envelope).not.toContain('/opt/autoforge')
    expect(envelope).not.toContain('server\\share')
    expect(envelope).not.toContain('C:\\Users')
    expect(envelope).not.toMatch(/owner|userId|https?:|generation/iu)
    expect(new TextEncoder().encode(envelope).byteLength).toBeLessThanOrEqual(40 * 1024)
    expect(envelope).toMatch(/END_UNTRUSTED_KNOWLEDGE_EVIDENCE$/u)
  })
})

describe('knowledge tool and answer validation', () => {
  it('accepts only bounded query and optional rewrite supplied by the model', () => {
    expect(parseKnowledgeSearchArguments({ query: '合同条款', rewrite: '违约责任' })).toEqual({
      query: '合同条款', rewrite: '违约责任',
    })
    for (const forbidden of ['baseIds', 'owner', 'topK', 'sql', 'path', 'generationId', 'tools']) {
      expect(() => parseKnowledgeSearchArguments({ query: '合同条款', [forbidden]: 'forged' })).toThrow()
    }
  })

  it('validates citations only against current-turn evidence and allows exactly one repair decision', () => {
    const registry = new CurrentTurnKnowledgeEvidence(['base_selected'])
    registry.add([evidence(0, { snippet: '结论来自当前证据。' }), evidence(1)])

    expect(validateKnowledgeAnswer('结论 [[kb:evidence:0]]', registry.snapshot(), 'strict', 0)).toEqual({
      kind: 'valid', citedEvidenceIds: ['evidence:0'], generalKnowledge: false, text: '结论',
    })
    expect(validateKnowledgeAnswer('伪造 [[kb:evidence:999]]', registry.snapshot(), 'strict', 0)).toEqual({
      kind: 'repair', invalidEvidenceIds: ['evidence:999'],
    })
    expect(validateKnowledgeAnswer('仍然伪造 [[kb:evidence:999]]', registry.snapshot(), 'strict', 1)).toEqual({
      kind: 'insufficient', reason: 'invalid-citation',
    })
  })

  it('fails strict answers closed and labels uncited mixed answers as general knowledge', () => {
    expect(validateKnowledgeAnswer('没有证据的结论', [], 'strict', 0)).toEqual({
      kind: 'insufficient', reason: 'no-evidence',
    })
    expect(validateKnowledgeAnswer('一般信息', [], 'mixed', 0)).toEqual({
      kind: 'valid', citedEvidenceIds: [], generalKnowledge: true, text: '【一般信息】一般信息',
    })
    expect(validateKnowledgeAnswer(
      '第 0 条证据 [[kb:evidence:0]]\n\n未由依据支持的补充', [evidence(0)], 'strict', 0,
    )).toEqual({ kind: 'repair', invalidEvidenceIds: ['uncited-material'] })
    expect(validateKnowledgeAnswer(
      '第 0 条证据 [[kb:evidence:0]]\n\n一般补充', [evidence(0)], 'mixed', 0,
    )).toEqual({
      kind: 'valid', citedEvidenceIds: ['evidence:0'], generalKnowledge: true,
      text: '【知识库依据】第 0 条证据\n【一般信息】一般补充',
    })
  })

  it('rejects unrelated cited claims and grounds mixed answers clause by clause', () => {
    const contract = evidence(0, { snippet: '合同经双方签字后生效。' })
    expect(validateKnowledgeAnswer(
      '月球由奶酪构成。[[kb:evidence:0]]', [contract], 'strict', 0,
    )).toEqual({ kind: 'repair', invalidEvidenceIds: ['unsupported-claim'] })
    expect(validateKnowledgeAnswer(
      '月球由奶酪构成。[[kb:evidence:0]]', [contract], 'strict', 1,
    )).toEqual({ kind: 'insufficient', reason: 'unsupported-claim' })

    expect(validateKnowledgeAnswer(
      '合同经双方签字后生效[[kb:evidence:0]]，但月球由奶酪构成[[kb:evidence:0]]。',
      [contract], 'mixed', 0,
    )).toEqual({
      kind: 'valid', citedEvidenceIds: ['evidence:0'], generalKnowledge: true,
      text: '【知识库依据】合同经双方签字后生效\n【一般信息】但月球由奶酪构成。',
    })
  })

  it('downgrades mixed claims whose current cited source became unavailable', () => {
    const contract = evidence(0, { snippet: '合同经双方签字后生效。' })
    const validation = validateKnowledgeAnswer(
      '合同经双方签字后生效。[[kb:evidence:0]]', [contract], 'mixed', 0,
    )
    expect(validation.kind).toBe('valid')
    if (validation.kind !== 'valid') throw new Error('Expected valid answer')
    expect(formatValidatedKnowledgeAnswer(validation, 'mixed', new Set())).toBe(
      '【一般信息】合同经双方签字后生效。（来源当前不可用）',
    )
  })

  it('requires a citation on each strict factual sentence and bounds eight emoji snippets by UTF-8 bytes', () => {
    expect(validateKnowledgeAnswer(
      '第一句没有依据。第二句有依据。[[kb:evidence:0]]', [evidence(0)], 'strict', 0,
    )).toEqual({ kind: 'repair', invalidEvidenceIds: ['uncited-material'] })

    const registry = new CurrentTurnKnowledgeEvidence(['base_selected'])
    registry.add(Array.from({ length: 8 }, (_, index) => evidence(index, {
      snippet: '😀'.repeat(2_000),
      citation: {
        evidenceId: `evidence:${index}`, documentId: `document_${index}`, versionId: `version_${index}`,
        coordinate: { kind: 'docx', headingPath: ['😀'.repeat(500)], paragraph: index },
      },
    })))
    const envelope = registry.providerEnvelope(registry.snapshot())
    expect(new TextEncoder().encode(envelope).byteLength).toBeLessThanOrEqual(40 * 1024)
    expect(envelope).toMatch(/END_UNTRUSTED_KNOWLEDGE_EVIDENCE$/u)
  })
})
