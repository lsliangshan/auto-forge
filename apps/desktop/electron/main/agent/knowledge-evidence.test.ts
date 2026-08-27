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
      snippet: '正文 https://signed.example/object?token=private /Users/alice/private.txt 路径/etc/passwd 路径/secret,path=/opt/autoforge,source:/Users/bob/private \\\\server\\share\\secret.txt C:\\Users\\alice\\private.txt 比例 10/2 and/or docs/readme 章节/介绍 每秒/次',
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
    expect(envelope).not.toContain('/Users/bob')
    expect(envelope).not.toContain('/secret')
    expect(envelope).toContain('比例 10/2 and/or docs/readme 章节/介绍 每秒/次')
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

  it('propagates sentence-final markers and rejects polarity or modality contradictions', () => {
    const contract = evidence(0, { snippet: '合同经双方签字后生效。' })
    expect(validateKnowledgeAnswer(
      '合同经双方签字后生效，并且月球由奶酪构成。[[kb:evidence:0]]',
      [contract], 'strict', 0,
    )).toEqual({ kind: 'repair', invalidEvidenceIds: ['unsupported-claim'] })

    const permission = evidence(1, { snippet: '合同允许提前解除。' })
    expect(validateKnowledgeAnswer(
      '合同不得提前解除。[[kb:evidence:1]]', [permission], 'strict', 0,
    )).toEqual({ kind: 'repair', invalidEvidenceIds: ['unsupported-claim'] })

    const optionalSeal = evidence(2, { snippet: '合同不需要盖章即可生效。' })
    expect(validateKnowledgeAnswer(
      '合同需要盖章即可生效。[[kb:evidence:2]]', [optionalSeal], 'strict', 0,
    )).toEqual({ kind: 'repair', invalidEvidenceIds: ['unsupported-claim'] })
    expect(validateKnowledgeAnswer(
      '合同需要盖章即可生效。[[kb:evidence:2]]', [optionalSeal], 'strict', 1,
    )).toEqual({ kind: 'insufficient', reason: 'unsupported-claim' })

    const payer = evidence(3, { snippet: '甲方应在 7 日内付款。' })
    expect(validateKnowledgeAnswer(
      '乙方应在 7 日内付款。[[kb:evidence:3]]', [payer], 'strict', 0,
    )).toEqual({ kind: 'repair', invalidEvidenceIds: ['unsupported-claim'] })
  })

  it('accepts a bounded true synonym match with the same polarity and entities', () => {
    const contract = evidence(0, { snippet: '协议由双方签署之日起生效。' })
    expect(validateKnowledgeAnswer(
      '双方签订协议后，协议即开始起效。[[kb:evidence:0]]', [contract], 'strict', 0,
    )).toEqual({
      kind: 'valid', citedEvidenceIds: ['evidence:0'], generalKnowledge: false,
      text: '双方签订协议后\n协议即开始起效。',
    })
  })

  it('accepts bounded English paraphrases only after canonical terms still meet high coverage', () => {
    const contract = evidence(0, { snippet: 'The agreement takes effect when both parties sign it.' })
    expect(validateKnowledgeAnswer(
      'The contract becomes effective when both parties sign it. [[kb:evidence:0]]',
      [contract], 'strict', 0,
    )).toEqual({
      kind: 'valid', citedEvidenceIds: ['evidence:0'], generalKnowledge: false,
      text: 'The contract becomes effective when both parties sign it.',
    })
  })

  it.each([
    '会议时间为 12:30。',
    '服务费为 100.50 美元。',
    '注册资本为 1,000 美元。',
    '合同于 2026-08-01 生效。',
  ])('keeps numeric punctuation inside one supported material claim: %s', (text) => {
    expect(validateKnowledgeAnswer(`${text}[[kb:evidence:0]]`, [evidence(0, { snippet: text })], 'strict', 0)).toEqual({
      kind: 'valid', citedEvidenceIds: ['evidence:0'], generalKnowledge: false, text,
    })
  })

  it.each([
    {
      name: '完整公司名称替换',
      snippet: '供应商为北京星火科技有限公司。',
      answer: '供应商为上海星火科技有限公司。[[kb:evidence:0]]',
    },
    {
      name: '其他中文组织名称一处替换',
      snippet: '报告由华南创新研究院发布。',
      answer: '报告由华北创新研究院发布。[[kb:evidence:0]]',
    },
    {
      name: '中文地名一处替换不能被长句稀释',
      snippet: '该重点示范项目的主要实施地点位于杭州市西湖区并持续运营。',
      answer: '该重点示范项目的主要实施地点位于杭州市西湖县并持续运营。[[kb:evidence:0]]',
    },
    {
      name: '连续高信息片段替换不能被长句稀释',
      snippet: '该项目的核心交付成果必须采用红色标准格式并保持长期稳定。',
      answer: '该项目的核心交付成果必须采用蓝色标准格式并保持长期稳定。[[kb:evidence:0]]',
    },
  ])('rejects $name', ({ snippet, answer }) => {
    const current = evidence(0, { snippet })
    expect(validateKnowledgeAnswer(answer, [current], 'strict', 0)).toEqual({
      kind: 'repair', invalidEvidenceIds: ['unsupported-claim'],
    })
    expect(validateKnowledgeAnswer(answer, [current], 'strict', 1)).toEqual({
      kind: 'insufficient', reason: 'unsupported-claim',
    })
  })

  it.each([
    {
      name: '中文普通逗号后的无关月球断言',
      snippet: '合同经双方签字后生效。',
      answer: '合同经双方签字后生效，月球由奶酪构成。[[kb:evidence:0]]',
    },
    {
      name: '英国法律与中国法律实体冲突',
      snippet: '本合同适用中国法律。',
      answer: '本合同适用英国法律。[[kb:evidence:0]]',
    },
    {
      name: 'English effective and not effective polarity conflict',
      snippet: 'The contract is effective on signature.',
      answer: 'The contract is not effective on signature. [[kb:evidence:0]]',
    },
    {
      name: 'English permits and prohibits early termination conflict',
      snippet: 'The contract permits early termination.',
      answer: 'The contract prohibits early termination. [[kb:evidence:0]]',
    },
    {
      name: '数字只能精确匹配而不能命中较长数字',
      snippet: '合同期限为 17 日。',
      answer: '合同期限为 7 日。[[kb:evidence:0]]',
    },
    {
      name: '货币实体不能跨币种复用',
      snippet: '服务费为 100 美元。',
      answer: '服务费为 100 人民币。[[kb:evidence:0]]',
    },
    {
      name: '日期必须完整精确匹配',
      snippet: '合同于 2026-08-01 生效。',
      answer: '合同于 2026-08-02 生效。[[kb:evidence:0]]',
    },
    {
      name: '英文专名实体必须出现在证据中',
      snippet: 'Acme permits early termination.',
      answer: 'Globex permits early termination. [[kb:evidence:0]]',
    },
  ])('repairs then fails closed for $name', ({ snippet, answer }) => {
    const current = evidence(0, { snippet })
    expect(validateKnowledgeAnswer(answer, [current], 'strict', 0)).toEqual({
      kind: 'repair', invalidEvidenceIds: ['unsupported-claim'],
    })
    expect(validateKnowledgeAnswer(answer, [current], 'strict', 1)).toEqual({
      kind: 'insufficient', reason: 'unsupported-claim',
    })
  })

  it('downgrades only the unsupported comma clause in mixed mode', () => {
    const contract = evidence(0, { snippet: '合同经双方签字后生效。' })
    expect(validateKnowledgeAnswer(
      '合同经双方签字后生效，月球由奶酪构成。[[kb:evidence:0]]',
      [contract], 'mixed', 0,
    )).toEqual({
      kind: 'valid', citedEvidenceIds: ['evidence:0'], generalKnowledge: true,
      text: '【知识库依据】合同经双方签字后生效\n【一般信息】月球由奶酪构成。',
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
