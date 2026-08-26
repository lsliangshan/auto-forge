import { describe, expect, it } from 'vitest'
import {
  evaluateGroundingCases,
  evaluateProcessingCases,
  evaluateRetrievalCases,
  percentile,
} from './release-evaluation.js'

describe('knowledge local release evaluation', () => {
  it('measures Recall@8 without retaining query or snippet payloads', async () => {
    const report = await evaluateRetrievalCases([
      { id: 'r1', query: 'synthetic-one', expectedEvidenceIds: ['e1'] },
      { id: 'r2', query: 'synthetic-two', expectedEvidenceIds: ['e2', 'e3'] },
    ], async (query) => query.endsWith('one')
      ? [{ evidenceId: 'e1' }]
      : [{ evidenceId: 'e2' }, ...Array.from({ length: 8 }, (_, index) => ({ evidenceId: `noise-${index}` })), { evidenceId: 'e3' }])

    expect(report).toEqual({
      fixtureClass: 'synthetic_local',
      officialAcceptanceEligible: false,
      caseCount: 2,
      expectedCount: 3,
      recalledCount: 2,
      recallAt8: 2 / 3,
      cases: [
        { id: 'r1', expectedCount: 1, recalledCount: 1 },
        { id: 'r2', expectedCount: 2, recalledCount: 1 },
      ],
    })
    expect(JSON.stringify(report)).not.toContain('synthetic-one')
    expect(JSON.stringify(report)).not.toContain('synthetic-two')
  })

  it('independently scores exact cited Unicode sentences and no-evidence refusal', () => {
    const report = evaluateGroundingCases([
      {
        id: 'g1', expectedEvidence: true,
        evidence: [{ id: 'e1', text: '第一句。第二句包含事实。' }],
        outcome: 'answered',
        claims: [{ text: '第二句包含事实。', citationIds: ['e1'] }],
      },
      {
        id: 'g2', expectedEvidence: true,
        evidence: [{ id: 'e2', text: '唯一事实。' }],
        outcome: 'answered',
        claims: [{ text: '相反事实。', citationIds: ['e2'] }],
      },
      {
        id: 'g3', expectedEvidence: false, evidence: [], outcome: 'refused', claims: [],
      },
    ])

    expect(report).toEqual({
      fixtureClass: 'synthetic_local',
      officialAcceptanceEligible: false,
      answeredEvidenceCases: 2,
      groundedEvidenceCases: 1,
      knowledgeClaimCount: 2,
      supportedClaimCount: 1,
      noEvidenceCaseCount: 1,
      correctNoEvidenceCount: 1,
      citationSupportRate: 0.5,
      groundedAnswerRate: 0.5,
      correctNoEvidenceRate: 1,
      cases: [
        { id: 'g1', grounded: true, noEvidenceCorrect: false },
        { id: 'g2', grounded: false, noEvidenceCorrect: false },
        { id: 'g3', grounded: false, noEvidenceCorrect: true },
      ],
    })
    expect(JSON.stringify(report)).not.toContain('第二句包含事实')
  })

  it('rejects a no-evidence refusal that still makes a material claim', () => {
    const report = evaluateGroundingCases([{
      id: 'g-refusal-with-claim',
      expectedEvidence: false,
      evidence: [],
      outcome: 'refused',
      claims: [{ text: '未获证据支持的事实。', citationIds: [] }],
    }])

    expect(report.correctNoEvidenceCount).toBe(0)
    expect(report.correctNoEvidenceRate).toBe(0)
    expect(report.cases).toEqual([{
      id: 'g-refusal-with-claim',
      grounded: false,
      noEvidenceCorrect: false,
    }])
  })

  it('measures supported processing outcomes and a nearest-rank p95', () => {
    expect(evaluateProcessingCases([
      { id: 'p1', supported: true, ready: true },
      { id: 'p2', supported: true, ready: false },
      { id: 'p3', supported: false, ready: false },
    ])).toEqual({
      fixtureClass: 'synthetic_local',
      officialAcceptanceEligible: false,
      supportedCount: 2,
      readyCount: 1,
      successRate: 0.5,
      cases: [{ id: 'p1', ready: true }, { id: 'p2', ready: false }],
    })
    expect(percentile([9, 1, 5, 4, 3, 2, 8, 7, 6, 10], 0.95)).toBe(10)
    expect(() => percentile([], 0.95)).toThrow(/sample/i)
  })
})
