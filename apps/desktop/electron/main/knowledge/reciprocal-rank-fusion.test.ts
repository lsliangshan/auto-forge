import { describe, expect, it } from 'vitest'
import { cosineSimilarity, rankByCosine, reciprocalRankFusion } from './reciprocal-rank-fusion'

describe('reciprocal rank fusion', () => {
  it('uses deterministic identifier tie-breaking regardless of input order', () => {
    const first = reciprocalRankFusion([
      [{ knowledgeBaseId: 'kb_1', id: 'chunk_b' }, { knowledgeBaseId: 'kb_1', id: 'chunk_a' }],
      [{ knowledgeBaseId: 'kb_1', id: 'chunk_a' }, { knowledgeBaseId: 'kb_1', id: 'chunk_b' }],
    ], { limit: 8 })
    const second = reciprocalRankFusion([
      [{ knowledgeBaseId: 'kb_1', id: 'chunk_a' }, { knowledgeBaseId: 'kb_1', id: 'chunk_b' }],
      [{ knowledgeBaseId: 'kb_1', id: 'chunk_b' }, { knowledgeBaseId: 'kb_1', id: 'chunk_a' }],
    ], { limit: 8 })

    expect(first.map(result => result.id)).toEqual(['chunk_a', 'chunk_b'])
    expect(second.map(result => result.id)).toEqual(['chunk_a', 'chunk_b'])
    expect(first[0]?.score).toBe(first[1]?.score)
  })

  it('deduplicates an identifier within a ranking before assigning reciprocal rank', () => {
    const results = reciprocalRankFusion([
      [
        { knowledgeBaseId: 'kb_1', id: 'chunk_a' },
        { knowledgeBaseId: 'kb_1', id: 'chunk_a' },
        { knowledgeBaseId: 'kb_1', id: 'chunk_b' },
      ],
    ], { rankConstant: 60, limit: 8 })

    expect(results).toEqual([
      { knowledgeBaseId: 'kb_1', id: 'chunk_a', score: 1 / 61, bestRank: 1 },
      { knowledgeBaseId: 'kb_1', id: 'chunk_b', score: 1 / 62, bestRank: 2 },
    ])
  })

  it('keeps the same chunk identifier from two bases as distinct candidates', () => {
    const results = reciprocalRankFusion([[
      { knowledgeBaseId: 'kb_b', id: 'chunk_same' },
      { knowledgeBaseId: 'kb_a', id: 'chunk_same' },
    ]], { limit: 8 })

    expect(results.map(({ knowledgeBaseId, id }) => [knowledgeBaseId, id])).toEqual([
      ['kb_b', 'chunk_same'],
      ['kb_a', 'chunk_same'],
    ])
  })
})

describe('small-set exact cosine ranking', () => {
  it('requires exact dimensions and finite values', () => {
    expect(cosineSimilarity([1, 0], [1], 2)).toBeUndefined()
    expect(cosineSimilarity([1, Number.NaN], [1, 0], 2)).toBeUndefined()
    expect(cosineSimilarity([0, 0], [1, 0], 2)).toBeUndefined()
    expect(cosineSimilarity([1, 0], [1, 0], 2)).toBe(1)
  })

  it('sorts equal cosine scores by stable identifier and omits invalid vectors', () => {
    expect(rankByCosine([1, 0], [
      { knowledgeBaseId: 'kb_1', id: 'chunk_b', vector: [1, 0] },
      { knowledgeBaseId: 'kb_1', id: 'chunk_invalid', vector: [1] },
      { knowledgeBaseId: 'kb_1', id: 'chunk_a', vector: [2, 0] },
    ], 2).map(candidate => candidate.id)).toEqual(['chunk_a', 'chunk_b'])
  })
})
