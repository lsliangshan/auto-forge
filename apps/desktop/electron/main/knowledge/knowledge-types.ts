import type {
  KnowledgeAvailability,
  KnowledgeBaseSummary,
  KnowledgeConsentState,
  KnowledgeDocumentSummary,
  KnowledgeEntitlementState,
  KnowledgeRetentionSelection,
  KnowledgeSearchResult,
  KnowledgeImportHandle,
  KnowledgeSelection,
  KnowledgeSourcePreview,
  KnowledgeSourcePreviewRequest,
  ModelProviderId,
  KnowledgeVersionSummary,
} from '@autoforge/shared'
import { toSafeAppError } from '@autoforge/shared'

/** Main-only authenticated ownership context; it never crosses preload or IPC. */
export interface KnowledgeOwner {
  readonly userId: string
}

/** Main-owned persistence and admission seam for a personal knowledge library. */
export interface KnowledgeService {
  list(owner: KnowledgeOwner): Promise<KnowledgeBaseSummary[]>
  create(owner: KnowledgeOwner, name: string): Promise<KnowledgeBaseSummary>
  listDocuments(owner: KnowledgeOwner, baseId: string): Promise<KnowledgeDocumentSummary[]>
  listVersions(owner: KnowledgeOwner, documentId: string): Promise<KnowledgeVersionSummary[]>
  pickImportFiles(owner: KnowledgeOwner): Promise<KnowledgeImportHandle[]>
  importDocument(owner: KnowledgeOwner, baseId: string, importHandleId: string): Promise<KnowledgeDocumentSummary | undefined>
  replaceDocument(owner: KnowledgeOwner, documentId: string, importHandleId: string): Promise<KnowledgeDocumentSummary | undefined>
  recycleDocument(owner: KnowledgeOwner, documentId: string): Promise<void>
  restoreDocument(owner: KnowledgeOwner, documentId: string): Promise<void>
  purgeDocument(owner: KnowledgeOwner, documentId: string): Promise<void>
  recycleBase(owner: KnowledgeOwner, baseId: string): Promise<void>
  restoreBase(owner: KnowledgeOwner, baseId: string): Promise<void>
  purgeBase(owner: KnowledgeOwner, baseId: string): Promise<void>
  exportBase(owner: KnowledgeOwner, baseId: string): Promise<void>
  getSelection(owner: KnowledgeOwner, conversationId: string): Promise<KnowledgeSelection>
  updateSelection(owner: KnowledgeOwner, conversationId: string, selection: KnowledgeSelection): Promise<KnowledgeSelection>
  search(owner: KnowledgeOwner, query: string): Promise<KnowledgeSearchResult>
  getAvailability(owner: KnowledgeOwner): Promise<KnowledgeAvailability>
  getEntitlement(owner: KnowledgeOwner): Promise<KnowledgeEntitlementState>
  retainFreeAllowance(owner: KnowledgeOwner, input: KnowledgeRetentionSelection): Promise<KnowledgeEntitlementState>
  getConsent(owner: KnowledgeOwner, provider?: ModelProviderId): Promise<KnowledgeConsentState>
  setConsent(owner: KnowledgeOwner, provider: ModelProviderId, status: 'granted' | 'denied'): Promise<KnowledgeConsentState>
  revokeConsent(owner: KnowledgeOwner, provider: ModelProviderId): Promise<KnowledgeConsentState>
  getSourcePreview(owner: KnowledgeOwner, input: KnowledgeSourcePreviewRequest): Promise<KnowledgeSourcePreview>
}

function unavailable(): never {
  throw toSafeAppError({ code: 'SERVICE_UNAVAILABLE' })
}

/** Fail-closed placeholder until encrypted storage and parsing are admitted. */
export function createUnavailableKnowledgeService(): KnowledgeService {
  return {
    list: async () => unavailable(),
    create: async () => unavailable(),
    listDocuments: async () => unavailable(),
    listVersions: async () => unavailable(),
    pickImportFiles: async () => unavailable(),
    importDocument: async () => unavailable(),
    replaceDocument: async () => unavailable(),
    recycleDocument: async () => unavailable(),
    restoreDocument: async () => unavailable(),
    purgeDocument: async () => unavailable(),
    recycleBase: async () => unavailable(),
    restoreBase: async () => unavailable(),
    purgeBase: async () => unavailable(),
    exportBase: async () => unavailable(),
    getSelection: async () => unavailable(),
    updateSelection: async () => unavailable(),
    search: async () => unavailable(),
    getAvailability: async () => ({
      encryption: { available: false, reason: 'encryption_unavailable' },
      parser: { available: false, reason: 'parser_unavailable' },
      cloudbase: { available: false, reason: 'cloudbase_unavailable' },
      embedding: { available: false, reason: 'embedding_unavailable' },
      entitlement: { available: false, reason: 'entitlement_unavailable' },
      beta: { available: false, reason: 'beta_disabled' },
      cloud: { available: false, reason: 'cloud_disabled' },
    }),
    getEntitlement: async () => ({ tier: 'free', status: 'unavailable', localEnabled: false, cloudEnabled: false }),
    retainFreeAllowance: async () => unavailable(),
    getConsent: async () => ({ provider: 'openrouter', status: 'unknown' }),
    setConsent: async () => unavailable(),
    revokeConsent: async () => unavailable(),
    getSourcePreview: async () => ({ kind: 'unavailable' }),
  }
}
