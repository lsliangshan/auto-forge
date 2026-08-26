import { describe, expect, it } from 'vitest'
import {
  assessKnowledgeRelease,
  PRODUCTION_KNOWLEDGE_RELEASE_EVIDENCE,
  type KnowledgeReleaseEvidence,
} from './release-gates.js'

const completeEvidence: KnowledgeReleaseEvidence = {
  approvedEvaluationCorpus: true,
  approvedRecallAt8: 0.91,
  approvedCitationSupportRate: 0.96,
  approvedGroundedAnswerRate: 0.96,
  approvedNoEvidenceRate: 0.96,
  approvedProcessingSuccessRate: 0.995,
  approvedPerformanceProfile: true,
  cloudBasePreproduction: true,
  cloudBaseAuthorization: true,
  tokenHubConsentAndRevocation: true,
  chatProviderDisclosure: true,
  productionEntitlementKey: true,
  productionEntitlementSigner: true,
  internalTelemetryReview: true,
  packagedNative: {
    darwinArm64: true,
    darwinX64: true,
    windowsX64: true,
  },
}

describe('knowledge release gates', () => {
  it('keeps beta and cloud disabled when only synthetic and current-host evidence exists', () => {
    const result = assessKnowledgeRelease({
      ...completeEvidence,
      approvedEvaluationCorpus: false,
      cloudBasePreproduction: false,
      productionEntitlementKey: false,
      productionEntitlementSigner: false,
      internalTelemetryReview: false,
      packagedNative: {
        darwinArm64: true,
        darwinX64: false,
        windowsX64: false,
      },
    })

    expect(result).toEqual({
      betaEnabled: false,
      cloudEnabled: false,
      blockers: [
        'approved_evaluation_corpus',
        'cloudbase_preproduction',
        'production_entitlement_key',
        'production_entitlement_signer',
        'internal_telemetry_review',
        'packaged_native_darwin_x64',
        'packaged_native_windows_x64',
      ],
    })
  })

  it('requires every approved correctness threshold instead of rounding near misses up', () => {
    const result = assessKnowledgeRelease({
      ...completeEvidence,
      approvedRecallAt8: 0.899999,
      approvedCitationSupportRate: 0.949999,
      approvedGroundedAnswerRate: 0.949999,
      approvedNoEvidenceRate: 0.949999,
      approvedProcessingSuccessRate: 0.989999,
    })

    expect(result.betaEnabled).toBe(false)
    expect(result.cloudEnabled).toBe(false)
    expect(result.blockers).toEqual([
      'approved_recall_at_8',
      'approved_citation_support_rate',
      'approved_grounded_answer_rate',
      'approved_no_evidence_rate',
      'approved_processing_success_rate',
    ])
  })

  it('allows cloud only after the complete approved gate set passes', () => {
    expect(assessKnowledgeRelease(completeEvidence)).toEqual({
      betaEnabled: true,
      cloudEnabled: true,
      blockers: [],
    })
  })

  it('ships production evidence closed with no approved external or platform claims', () => {
    expect(assessKnowledgeRelease(PRODUCTION_KNOWLEDGE_RELEASE_EVIDENCE)).toMatchObject({
      betaEnabled: false,
      cloudEnabled: false,
    })
    expect(PRODUCTION_KNOWLEDGE_RELEASE_EVIDENCE.packagedNative).toEqual({
      darwinArm64: false,
      darwinX64: false,
      windowsX64: false,
    })
  })
})
