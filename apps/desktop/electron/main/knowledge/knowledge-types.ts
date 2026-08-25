import type {
  KnowledgeBase,
  KnowledgeConsentState,
  KnowledgeDocument,
  KnowledgeEntitlementState,
  KnowledgeFeatureAvailability,
  KnowledgeSelection,
  KnowledgeVersion,
} from '@autoforge/shared'

/** Main-only authenticated ownership context; never crosses preload or IPC. */
export interface KnowledgeOwner {
  readonly userId: string
}

/** Persistence seam for the encrypted per-owner knowledge store. */
export interface KnowledgePersistence {
  listBases(owner: KnowledgeOwner): Promise<KnowledgeBase[]>
  listDocuments(owner: KnowledgeOwner, knowledgeBaseId: string): Promise<KnowledgeDocument[]>
  listVersions(owner: KnowledgeOwner, documentId: string): Promise<KnowledgeVersion[]>
  getConversationSelection(owner: KnowledgeOwner, conversationId: string): Promise<KnowledgeSelection>
  updateConversationSelection(
    owner: KnowledgeOwner,
    conversationId: string,
    selection: KnowledgeSelection,
  ): Promise<KnowledgeSelection>
  getFeatureAvailability(): Promise<KnowledgeFeatureAvailability>
  getEntitlement(owner: KnowledgeOwner): Promise<KnowledgeEntitlementState>
  getConsent(owner: KnowledgeOwner): Promise<KnowledgeConsentState>
}
