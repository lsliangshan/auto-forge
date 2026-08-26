export interface KnowledgeReleaseEvidence {
  readonly approvedEvaluationCorpus: boolean
  readonly approvedRecallAt8: number
  readonly approvedCitationSupportRate: number
  readonly approvedGroundedAnswerRate: number
  readonly approvedNoEvidenceRate: number
  readonly approvedProcessingSuccessRate: number
  readonly approvedPerformanceProfile: boolean
  readonly cloudBasePreproduction: boolean
  readonly cloudBaseAuthorization: boolean
  readonly tokenHubConsentAndRevocation: boolean
  readonly chatProviderDisclosure: boolean
  readonly productionEntitlementKey: boolean
  readonly productionEntitlementSigner: boolean
  readonly internalTelemetryReview: boolean
  readonly packagedNative: {
    readonly darwinArm64: boolean
    readonly darwinX64: boolean
    readonly windowsX64: boolean
  }
}

export interface KnowledgeReleaseAssessment {
  readonly betaEnabled: boolean
  readonly cloudEnabled: boolean
  readonly blockers: readonly string[]
}

const REQUIRED_BOOLEAN_GATES = [
  ['approvedEvaluationCorpus', 'approved_evaluation_corpus'],
  ['approvedPerformanceProfile', 'approved_performance_profile'],
  ['cloudBasePreproduction', 'cloudbase_preproduction'],
  ['cloudBaseAuthorization', 'cloudbase_authorization'],
  ['tokenHubConsentAndRevocation', 'tokenhub_consent_and_revocation'],
  ['chatProviderDisclosure', 'chat_provider_disclosure'],
  ['productionEntitlementKey', 'production_entitlement_key'],
  ['productionEntitlementSigner', 'production_entitlement_signer'],
  ['internalTelemetryReview', 'internal_telemetry_review'],
] as const

const REQUIRED_THRESHOLDS = [
  ['approvedRecallAt8', 0.9, 'approved_recall_at_8'],
  ['approvedCitationSupportRate', 0.95, 'approved_citation_support_rate'],
  ['approvedGroundedAnswerRate', 0.95, 'approved_grounded_answer_rate'],
  ['approvedNoEvidenceRate', 0.95, 'approved_no_evidence_rate'],
  ['approvedProcessingSuccessRate', 0.99, 'approved_processing_success_rate'],
] as const

export function assessKnowledgeRelease(
  evidence: KnowledgeReleaseEvidence,
): KnowledgeReleaseAssessment {
  const blockers: string[] = []
  for (const [field, blocker] of REQUIRED_BOOLEAN_GATES) {
    if (!evidence[field]) blockers.push(blocker)
  }
  for (const [field, threshold, blocker] of REQUIRED_THRESHOLDS) {
    if (!Number.isFinite(evidence[field]) || evidence[field] < threshold) blockers.push(blocker)
  }
  if (!evidence.packagedNative.darwinArm64) blockers.push('packaged_native_darwin_arm64')
  if (!evidence.packagedNative.darwinX64) blockers.push('packaged_native_darwin_x64')
  if (!evidence.packagedNative.windowsX64) blockers.push('packaged_native_windows_x64')
  const enabled = blockers.length === 0
  return { betaEnabled: enabled, cloudEnabled: enabled, blockers }
}

/**
 * Repository production defaults remain closed until every external owner supplies
 * audited evidence. Local and synthetic Task 10 measurements never mutate this set.
 */
export const PRODUCTION_KNOWLEDGE_RELEASE_EVIDENCE: KnowledgeReleaseEvidence = Object.freeze({
  approvedEvaluationCorpus: false,
  approvedRecallAt8: 0,
  approvedCitationSupportRate: 0,
  approvedGroundedAnswerRate: 0,
  approvedNoEvidenceRate: 0,
  approvedProcessingSuccessRate: 0,
  approvedPerformanceProfile: false,
  cloudBasePreproduction: false,
  cloudBaseAuthorization: false,
  tokenHubConsentAndRevocation: false,
  chatProviderDisclosure: false,
  productionEntitlementKey: false,
  productionEntitlementSigner: false,
  internalTelemetryReview: false,
  packagedNative: Object.freeze({
    darwinArm64: false,
    darwinX64: false,
    windowsX64: false,
  }),
})
