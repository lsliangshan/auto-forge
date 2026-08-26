interface RetrievalCase {
  readonly id: string
  readonly query: string
  readonly expectedEvidenceIds: readonly string[]
}

interface RetrievedEvidence {
  readonly evidenceId: string
}

interface GroundingCase {
  readonly id: string
  readonly expectedEvidence: boolean
  readonly evidence: readonly { readonly id: string; readonly text: string }[]
  readonly outcome: 'answered' | 'refused'
  readonly claims: readonly {
    readonly text: string
    readonly citationIds: readonly string[]
  }[]
}

interface ProcessingCase {
  readonly id: string
  readonly supported: boolean
  readonly ready: boolean
}

const SYNTHETIC_MARKER = {
  fixtureClass: 'synthetic_local' as const,
  officialAcceptanceEligible: false as const,
}

export async function evaluateRetrievalCases(
  cases: readonly RetrievalCase[],
  search: (query: string) => Promise<readonly RetrievedEvidence[]>,
) {
  const results: Array<{ id: string; expectedCount: number; recalledCount: number }> = []
  for (const testCase of cases) {
    const topEight = new Set((await search(testCase.query)).slice(0, 8).map(result => result.evidenceId))
    results.push({
      id: testCase.id,
      expectedCount: testCase.expectedEvidenceIds.length,
      recalledCount: testCase.expectedEvidenceIds.filter(id => topEight.has(id)).length,
    })
  }
  const expectedCount = results.reduce((sum, result) => sum + result.expectedCount, 0)
  const recalledCount = results.reduce((sum, result) => sum + result.recalledCount, 0)
  return {
    ...SYNTHETIC_MARKER,
    caseCount: results.length,
    expectedCount,
    recalledCount,
    recallAt8: expectedCount === 0 ? 0 : recalledCount / expectedCount,
    cases: results,
  }
}

function normalizedSentence(value: string): string {
  return value.normalize('NFC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('und')
}

function sentences(value: string): readonly string[] {
  const Segmenter = Intl.Segmenter
  if (typeof Segmenter !== 'function') return []
  return [...new Segmenter('und', { granularity: 'sentence' }).segment(value)]
    .map(({ segment }) => normalizedSentence(segment))
    .filter(Boolean)
}

function supportsClaim(testCase: GroundingCase, claim: GroundingCase['claims'][number]): boolean {
  if (claim.citationIds.length === 0) return false
  const claimSentence = normalizedSentence(claim.text)
  if (sentences(claim.text).length !== 1) return false
  return claim.citationIds.some(citationId => {
    const cited = testCase.evidence.find(evidence => evidence.id === citationId)
    return cited !== undefined && sentences(cited.text).includes(claimSentence)
  })
}

export function evaluateGroundingCases(cases: readonly GroundingCase[]) {
  let supportedClaimCount = 0
  let knowledgeClaimCount = 0
  let groundedEvidenceCases = 0
  let answeredEvidenceCases = 0
  let noEvidenceCaseCount = 0
  let correctNoEvidenceCount = 0
  const caseResults: Array<{ id: string; grounded: boolean; noEvidenceCorrect: boolean }> = []
  for (const testCase of cases) {
    const supported = testCase.claims.map(claim => supportsClaim(testCase, claim))
    knowledgeClaimCount += supported.length
    supportedClaimCount += supported.filter(Boolean).length
    const grounded = testCase.expectedEvidence
      && testCase.outcome === 'answered'
      && supported.length > 0
      && supported.every(Boolean)
    const noEvidenceCorrect = !testCase.expectedEvidence && testCase.outcome === 'refused'
    if (testCase.expectedEvidence) {
      answeredEvidenceCases += 1
      if (grounded) groundedEvidenceCases += 1
    } else {
      noEvidenceCaseCount += 1
      if (noEvidenceCorrect) correctNoEvidenceCount += 1
    }
    caseResults.push({ id: testCase.id, grounded, noEvidenceCorrect })
  }
  return {
    ...SYNTHETIC_MARKER,
    answeredEvidenceCases,
    groundedEvidenceCases,
    knowledgeClaimCount,
    supportedClaimCount,
    noEvidenceCaseCount,
    correctNoEvidenceCount,
    citationSupportRate: knowledgeClaimCount === 0 ? 0 : supportedClaimCount / knowledgeClaimCount,
    groundedAnswerRate: answeredEvidenceCases === 0 ? 0 : groundedEvidenceCases / answeredEvidenceCases,
    correctNoEvidenceRate: noEvidenceCaseCount === 0 ? 0 : correctNoEvidenceCount / noEvidenceCaseCount,
    cases: caseResults,
  }
}

export function evaluateProcessingCases(cases: readonly ProcessingCase[]) {
  const supported = cases.filter(testCase => testCase.supported)
  const readyCount = supported.filter(testCase => testCase.ready).length
  return {
    ...SYNTHETIC_MARKER,
    supportedCount: supported.length,
    readyCount,
    successRate: supported.length === 0 ? 0 : readyCount / supported.length,
    cases: supported.map(({ id, ready }) => ({ id, ready })),
  }
}

export function percentile(samples: readonly number[], fraction: number): number {
  if (samples.length === 0) throw new Error('At least one sample is required')
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1) {
    throw new Error('Percentile fraction must be greater than zero and at most one')
  }
  const ordered = [...samples].sort((left, right) => left - right)
  return ordered[Math.ceil(fraction * ordered.length) - 1]!
}
