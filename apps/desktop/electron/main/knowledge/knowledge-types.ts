import type {
  KnowledgeBase,
  KnowledgeConsentState,
  KnowledgeDocument,
  KnowledgeEntitlementState,
  KnowledgeFeatureAvailability,
  KnowledgeSelection,
  KnowledgeSearchOutcome,
  KnowledgeVersion,
} from '@autoforge/shared'

/** Main-only authenticated ownership context; never crosses preload or IPC. */
export interface KnowledgeOwner {
  readonly userId: string
}

/** Persistence seam for the encrypted per-owner knowledge store. */
export interface KnowledgePersistence {
  listBases(owner: KnowledgeOwner): Promise<KnowledgeBase[]>
  createBase(owner: KnowledgeOwner, name: string): Promise<KnowledgeBase>
  listDocuments(owner: KnowledgeOwner, knowledgeBaseId: string): Promise<KnowledgeDocument[]>
  listVersions(owner: KnowledgeOwner, documentId: string): Promise<KnowledgeVersion[]>
  importDocument(owner: KnowledgeOwner, knowledgeBaseId: string): Promise<KnowledgeDocument | undefined>
  replaceDocument(owner: KnowledgeOwner, documentId: string): Promise<KnowledgeDocument | undefined>
  recycleDocument(owner: KnowledgeOwner, documentId: string): Promise<void>
  purgeDocument(owner: KnowledgeOwner, documentId: string): Promise<void>
  recycleBase(owner: KnowledgeOwner, knowledgeBaseId: string): Promise<void>
  purgeBase(owner: KnowledgeOwner, knowledgeBaseId: string): Promise<void>
  exportBase(owner: KnowledgeOwner, knowledgeBaseId: string): Promise<void>
  getConversationSelection(owner: KnowledgeOwner, conversationId: string): Promise<KnowledgeSelection>
  updateConversationSelection(
    owner: KnowledgeOwner,
    conversationId: string,
    selection: KnowledgeSelection,
  ): Promise<KnowledgeSelection>
  search(owner: KnowledgeOwner, conversationId: string, query: string): Promise<KnowledgeSearchOutcome>
  getFeatureAvailability(owner: KnowledgeOwner): Promise<KnowledgeFeatureAvailability>
  getEntitlement(owner: KnowledgeOwner): Promise<KnowledgeEntitlementState>
  getConsent(owner: KnowledgeOwner): Promise<KnowledgeConsentState>
}
