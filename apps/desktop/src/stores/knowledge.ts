import { acceptHMRUpdate, defineStore } from 'pinia'
import type {
  KnowledgeBase,
  KnowledgeConsentState,
  KnowledgeDocument,
  KnowledgeEntitlementState,
  KnowledgeFeatureAvailability,
  KnowledgeVersion,
} from '@autoforge/shared'
import { displayError, getDesktopApi } from '../services/desktop-api'

const processingDocumentStatuses = new Set<KnowledgeDocument['status']>([
  'queued', 'copying', 'uploading', 'parsing', 'indexing',
])
const POLL_INTERVAL_MS = 1_500
const MAX_POLL_FAILURES = 3

interface PollController {
  failures: number
  ownerEpoch: number
  timer?: ReturnType<typeof globalThis.setTimeout>
}

const pollingControllers = new WeakMap<object, PollController>()

function entitlementAllowsWrite(entitlement: KnowledgeEntitlementState | undefined): boolean {
  return Boolean(entitlement && ['active', 'offline_grace'].includes(entitlement.status))
}

function scopeAvailable(
  base: KnowledgeBase | undefined,
  availability: KnowledgeFeatureAvailability | undefined,
  entitlement: KnowledgeEntitlementState | undefined,
): boolean {
  if (!base || base.status === 'recycled') return false
  if (base.kind === 'local') return Boolean(availability?.local.available)
  return Boolean(availability?.cloud.available && entitlement?.cloudEnabled)
}

export const useKnowledgeStore = defineStore('knowledge', {
  state: () => ({
    bases: [] as KnowledgeBase[],
    documentsByBase: {} as Record<string, KnowledgeDocument[]>,
    versionsByDocument: {} as Record<string, KnowledgeVersion[]>,
    selectedBaseId: '',
    selectedDocumentId: '',
    availability: undefined as KnowledgeFeatureAvailability | undefined,
    entitlement: undefined as KnowledgeEntitlementState | undefined,
    consent: undefined as KnowledgeConsentState | undefined,
    loading: false,
    documentsLoading: false,
    versionsLoading: false,
    operationPending: false,
    error: '',
    operationError: '',
    pollingError: '',
    _ownerEpoch: 0,
    _catalogVersion: 0,
    _documentLoadVersions: {} as Record<string, number>,
    _versionLoadVersions: {} as Record<string, number>,
    _documentsLoadingVersion: 0,
    _versionsLoadingVersion: 0,
    _operationVersion: 0,
    _refreshVersion: 0,
  }),
  getters: {
    selectedBase(state): KnowledgeBase | undefined {
      return state.bases.find(({ id }) => id === state.selectedBaseId)
    },
    documents(state): KnowledgeDocument[] {
      return state.documentsByBase[state.selectedBaseId] ?? []
    },
    selectedDocument(state): KnowledgeDocument | undefined {
      return (state.documentsByBase[state.selectedBaseId] ?? [])
        .find(({ id }) => id === state.selectedDocumentId)
    },
    versions(state): KnowledgeVersion[] {
      return state.versionsByDocument[state.selectedDocumentId] ?? []
    },
    hasProcessing(state): boolean {
      return Object.values(state.documentsByBase).some((documents) =>
        documents.some(({ status }) => processingDocumentStatuses.has(status)))
    },
    canCreateBase(state): boolean {
      if (!state.availability?.local.available || !entitlementAllowsWrite(state.entitlement)) return false
      return state.entitlement?.tier === 'member'
        || state.bases.every(({ status }) => status === 'recycled')
    },
    canWrite(state): boolean {
      const base = state.bases.find(({ id }) => id === state.selectedBaseId)
      if (!base || base.status === 'read_only' || base.status === 'recycled') return false
      return scopeAvailable(base, state.availability, state.entitlement)
        && entitlementAllowsWrite(state.entitlement)
    },
    canImport(state): boolean {
      const base = state.bases.find(({ id }) => id === state.selectedBaseId)
      if (!base || !this.canWrite) return false
      if (state.entitlement?.tier === 'member') return true
      const documents = state.documentsByBase[base.id]
      return documents !== undefined && documents.every(({ status }) => status === 'deleted')
    },
    canReplace(state): boolean {
      const document = Object.values(state.documentsByBase)
        .flat()
        .find(({ id }) => id === state.selectedDocumentId)
      return Boolean(this.canWrite && document && document.status !== 'deleted')
    },
    canRecycle(state): boolean {
      const base = state.bases.find(({ id }) => id === state.selectedBaseId)
      return Boolean(base && base.status !== 'recycled' && state.availability?.local.available)
    },
    canPurge(state): boolean {
      const base = state.bases.find(({ id }) => id === state.selectedBaseId)
      return Boolean(base && state.availability?.local.available)
    },
    canExport(state): boolean {
      const base = state.bases.find(({ id }) => id === state.selectedBaseId)
      return Boolean(base && base.status !== 'recycled' && state.availability?.local.available)
    },
    embeddingRetrievalMode(state) {
      return (knowledgeBaseId: string): 'hybrid' | 'keyword_only' | 'reindexing' => (
        state.consent?.embedding.retrievalByBase.find(
          state => state.knowledgeBaseId === knowledgeBaseId,
        )?.retrievalMode ?? 'keyword_only'
      )
    },
  },
  actions: {
    reset() {
      this.stopProcessingPolling()
      this._ownerEpoch += 1
      this._catalogVersion += 1
      this._documentLoadVersions = {}
      this._versionLoadVersions = {}
      this._documentsLoadingVersion += 1
      this._versionsLoadingVersion += 1
      this._operationVersion += 1
      this._refreshVersion += 1
      this.bases = []
      this.documentsByBase = {}
      this.versionsByDocument = {}
      this.selectedBaseId = ''
      this.selectedDocumentId = ''
      this.availability = undefined
      this.entitlement = undefined
      this.consent = undefined
      this.loading = false
      this.documentsLoading = false
      this.versionsLoading = false
      this.operationPending = false
      this.error = ''
      this.operationError = ''
      this.pollingError = ''
    },
    async load() {
      const ownerEpoch = this._ownerEpoch
      const version = ++this._catalogVersion
      this.loading = true
      this.error = ''
      this.pollingError = ''
      try {
        const api = getDesktopApi().knowledge
        const availability = await api.getFeatureAvailability()
        if (ownerEpoch !== this._ownerEpoch || version !== this._catalogVersion) return
        this.availability = availability
        const [entitlement, consent] = await Promise.all([
          api.getEntitlement(),
          api.getConsent(),
        ])
        if (ownerEpoch !== this._ownerEpoch || version !== this._catalogVersion) return
        this.entitlement = entitlement
        this.consent = consent
        if (!availability.local.available && !availability.cloud.available) {
          this.bases = []
          this.selectedBaseId = ''
          this.selectedDocumentId = ''
          this.error = '当前设备无法安全启用知识库'
          return
        }
        const bases = await api.listBases()
        if (ownerEpoch !== this._ownerEpoch || version !== this._catalogVersion) return
        this.bases = bases
        this.entitlement = await api.getEntitlement()
        if (ownerEpoch !== this._ownerEpoch || version !== this._catalogVersion) return
        if (!bases.some(({ id }) => id === this.selectedBaseId)) {
          this.selectedBaseId = bases[0]?.id ?? ''
          this.selectedDocumentId = ''
        }
        if (this.selectedBaseId) await this.loadDocuments(this.selectedBaseId)
      } catch (error) {
        if (ownerEpoch === this._ownerEpoch && version === this._catalogVersion) {
          this.error = displayError(error, '知识库加载失败')
        }
      } finally {
        if (ownerEpoch === this._ownerEpoch && version === this._catalogVersion) this.loading = false
      }
    },
    async loadSelectorCatalog() {
      const ownerEpoch = this._ownerEpoch
      const version = ++this._catalogVersion
      try {
        const api = getDesktopApi().knowledge
        const availability = await api.getFeatureAvailability()
        if (ownerEpoch !== this._ownerEpoch || version !== this._catalogVersion) return
        this.availability = availability
        const [entitlement, consent] = await Promise.all([
          api.getEntitlement(),
          api.getConsent(),
        ])
        if (ownerEpoch !== this._ownerEpoch || version !== this._catalogVersion) return
        this.entitlement = entitlement
        this.consent = consent
        if (!availability.local.available && !availability.cloud.available) {
          this.bases = []
          return
        }
        const bases = await api.listBases()
        if (ownerEpoch !== this._ownerEpoch || version !== this._catalogVersion) return
        this.bases = bases
        this.entitlement = await api.getEntitlement()
        if (ownerEpoch !== this._ownerEpoch || version !== this._catalogVersion) return
        this.operationError = ''
      } catch (error) {
        if (ownerEpoch === this._ownerEpoch && version === this._catalogVersion) {
          this.operationError = displayError(error, '知识库选项加载失败')
          this.bases = []
        }
      }
    },
    async refreshCatalog() {
      const ownerEpoch = this._ownerEpoch
      const version = ++this._catalogVersion
      const bases = await getDesktopApi().knowledge.listBases()
      if (ownerEpoch !== this._ownerEpoch || version !== this._catalogVersion) return
      this.bases = bases
      if (!bases.some(({ id }) => id === this.selectedBaseId)) {
        this.selectedBaseId = bases[0]?.id ?? ''
        this.selectedDocumentId = ''
      }
      if (this.selectedBaseId) await this.loadDocuments(this.selectedBaseId)
    },
    async selectBase(id: string) {
      if (id === this.selectedBaseId) return
      this.selectedBaseId = id
      this.selectedDocumentId = ''
      await this.loadDocuments(id)
    },
    async loadDocuments(requestedKnowledgeBaseId?: string, background = false) {
      const knowledgeBaseId = requestedKnowledgeBaseId ?? this.selectedBaseId
      if (!knowledgeBaseId) return
      const ownerEpoch = this._ownerEpoch
      const version = (this._documentLoadVersions[knowledgeBaseId] ?? 0) + 1
      this._documentLoadVersions[knowledgeBaseId] = version
      const visible = !background && this.selectedBaseId === knowledgeBaseId
      const loadingVersion = visible ? ++this._documentsLoadingVersion : 0
      if (visible) this.documentsLoading = true
      try {
        const documents = await getDesktopApi().knowledge.listDocuments(knowledgeBaseId)
        if (ownerEpoch !== this._ownerEpoch
          || version !== this._documentLoadVersions[knowledgeBaseId]) return
        this.documentsByBase[knowledgeBaseId] = documents
        if (this.selectedBaseId === knowledgeBaseId
          && !documents.some(({ id }) => id === this.selectedDocumentId)) {
          this.selectedDocumentId = ''
        }
        if (!background && visible) this.operationError = ''
        return true
      } catch (error) {
        if (!background && this.selectedBaseId === knowledgeBaseId
          && ownerEpoch === this._ownerEpoch
          && version === this._documentLoadVersions[knowledgeBaseId]) {
          this.operationError = displayError(error, '文件列表加载失败')
        }
        return false
      } finally {
        if (visible && loadingVersion === this._documentsLoadingVersion
          && ownerEpoch === this._ownerEpoch
          && version === this._documentLoadVersions[knowledgeBaseId]) this.documentsLoading = false
      }
    },
    async selectDocument(id: string) {
      this.selectedDocumentId = id
      await this.loadVersions(id)
    },
    async loadVersions(requestedDocumentId?: string, background = false) {
      const documentId = requestedDocumentId ?? this.selectedDocumentId
      if (!documentId) return
      const ownerEpoch = this._ownerEpoch
      const version = (this._versionLoadVersions[documentId] ?? 0) + 1
      this._versionLoadVersions[documentId] = version
      const visible = !background && this.selectedDocumentId === documentId
      const loadingVersion = visible ? ++this._versionsLoadingVersion : 0
      if (visible) this.versionsLoading = true
      try {
        const versions = await getDesktopApi().knowledge.listVersions(documentId)
        if (ownerEpoch === this._ownerEpoch
          && version === this._versionLoadVersions[documentId]
          && this.selectedDocumentId === documentId) {
          this.versionsByDocument[documentId] = versions
          if (!background) this.operationError = ''
        }
        return true
      } catch (error) {
        if (!background && this.selectedDocumentId === documentId
          && ownerEpoch === this._ownerEpoch
          && version === this._versionLoadVersions[documentId]) {
          this.operationError = displayError(error, '版本列表加载失败')
        }
        return false
      } finally {
        if (visible && loadingVersion === this._versionsLoadingVersion
          && ownerEpoch === this._ownerEpoch
          && version === this._versionLoadVersions[documentId]) this.versionsLoading = false
      }
    },
    async createBase(rawName: string) {
      const name = rawName.trim()
      if (!name || this.operationPending || !this.canCreateBase) return
      await this.runOperation('创建知识库失败', async (isCurrent) => {
        const created = await getDesktopApi().knowledge.createBase(name)
        if (!isCurrent()) return
        this.bases = [created, ...this.bases.filter(({ id }) => id !== created.id)]
        this.selectedBaseId = created.id
        this.selectedDocumentId = ''
        this.documentsByBase[created.id] = []
      })
    },
    async setEmbeddingConsent(status: 'granted' | 'denied' | 'revoked') {
      if (this.operationPending) return
      await this.runOperation('TokenHub 授权更新失败', async (isCurrent) => {
        const consent = await getDesktopApi().knowledge.setEmbeddingConsent(status)
        if (isCurrent()) this.consent = consent
      })
    },
    async chooseDowngradeSelection() {
      const knowledgeBaseId = this.selectedBaseId
      const documentId = this.selectedDocumentId
      if (!knowledgeBaseId || !documentId || this.operationPending
        || !this.entitlement?.lifecycle?.requiresSelection) return
      await this.runOperation('保留文件选择失败', async (isCurrent) => {
        const entitlement = await getDesktopApi().knowledge.chooseDowngradeSelection(
          knowledgeBaseId,
          documentId,
        )
        if (!isCurrent()) return
        this.entitlement = entitlement
        await this.refreshCatalog()
      })
    },
    upsertDocument(document: KnowledgeDocument) {
      const existing = this.documentsByBase[document.knowledgeBaseId] ?? []
      this.documentsByBase[document.knowledgeBaseId] = [
        document,
        ...existing.filter(({ id }) => id !== document.id),
      ]
      this.selectedBaseId = document.knowledgeBaseId
      this.selectedDocumentId = document.id
    },
    async importDocument() {
      if (!this.selectedBaseId || this.operationPending || !this.canImport) return
      const knowledgeBaseId = this.selectedBaseId
      await this.runOperation('导入文件失败', async (isCurrent) => {
        const acknowledgement = await getDesktopApi().knowledge.importDocument(knowledgeBaseId)
        if (acknowledgement && isCurrent()) {
          this.upsertDocument(acknowledgement)
          this.startProcessingPolling()
        }
      })
    },
    async replaceSelectedDocument() {
      const documentId = this.selectedDocumentId
      if (!documentId || this.operationPending || !this.canReplace) return
      await this.runOperation('替换文件失败', async (isCurrent) => {
        const acknowledgement = await getDesktopApi().knowledge.replaceDocument(documentId)
        if (acknowledgement && isCurrent()) {
          this.upsertDocument(acknowledgement)
          this.startProcessingPolling()
        }
      })
    },
    async recycleSelectedDocument() {
      const document = this.selectedDocument
      if (!document || this.operationPending || !this.canRecycle) return
      await this.runOperation('移入回收站失败', async (isCurrent) => {
        await getDesktopApi().knowledge.recycleDocument(document.id)
        if (!isCurrent()) return
        this.documentsByBase[document.knowledgeBaseId] = this.documents
          .filter(({ id }) => id !== document.id)
        this.selectedDocumentId = ''
      })
    },
    async purgeSelectedDocument() {
      const document = this.selectedDocument
      if (!document || this.operationPending || !this.canPurge) return
      const knowledgeBaseId = document.knowledgeBaseId
      await this.runOperation('永久删除文件失败', async (isCurrent) => {
        await getDesktopApi().knowledge.purgeDocument(document.id)
        if (!isCurrent()) return
        this.documentsByBase[knowledgeBaseId] = (this.documentsByBase[knowledgeBaseId] ?? [])
          .filter(({ id }) => id !== document.id)
        if (this.selectedBaseId === knowledgeBaseId && this.selectedDocumentId === document.id) {
          this.selectedDocumentId = ''
        }
      })
    },
    async exportSelectedBase() {
      if (!this.selectedBaseId || this.operationPending || !this.canExport) return
      await this.runOperation('导出知识库失败', async () =>
        getDesktopApi().knowledge.exportBase(this.selectedBaseId))
    },
    async recycleSelectedBase() {
      const baseId = this.selectedBaseId
      if (!baseId || this.operationPending || !this.canRecycle) return
      await this.runOperation('移入回收站失败', async (isCurrent) => {
        await getDesktopApi().knowledge.recycleBase(baseId)
        if (!isCurrent()) return
        this.bases = this.bases.filter(({ id }) => id !== baseId)
        delete this.documentsByBase[baseId]
        this.selectedBaseId = this.bases[0]?.id ?? ''
        this.selectedDocumentId = ''
        if (this.selectedBaseId) await this.loadDocuments(this.selectedBaseId)
      })
    },
    async purgeSelectedBase() {
      const baseId = this.selectedBaseId
      if (!baseId || this.operationPending || !this.canPurge) return
      await this.runOperation('永久删除知识库失败', async (isCurrent) => {
        await getDesktopApi().knowledge.purgeBase(baseId)
        if (!isCurrent()) return
        this.bases = this.bases.filter(({ id }) => id !== baseId)
        delete this.documentsByBase[baseId]
        this.selectedBaseId = this.bases[0]?.id ?? ''
        this.selectedDocumentId = ''
        if (this.selectedBaseId) await this.loadDocuments(this.selectedBaseId)
      })
    },
    async refreshProcessing() {
      if (!this.hasProcessing) return true
      const ownerEpoch = this._ownerEpoch
      const refreshVersion = ++this._refreshVersion
      const selectedDocumentId = this.selectedDocumentId
      const refreshed = await Promise.all(Object.entries(this.documentsByBase)
        .filter(([, documents]) => documents.some(({ status }) => processingDocumentStatuses.has(status)))
        .map(([baseId]) => this.loadDocuments(baseId, true)))
      if (ownerEpoch !== this._ownerEpoch || refreshVersion !== this._refreshVersion) return false
      if (refreshed.some((success) => success === false)) return false
      if (selectedDocumentId && this.selectedDocumentId === selectedDocumentId) {
        const versionsLoaded = await this.loadVersions(selectedDocumentId, true)
        if (versionsLoaded === false) return false
      }
      const bases = await getDesktopApi().knowledge.listBases()
      if (ownerEpoch !== this._ownerEpoch || refreshVersion !== this._refreshVersion) return false
      this.bases = bases
      return true
    },
    startProcessingPolling() {
      this.stopProcessingPolling()
      this.pollingError = ''
      if (!this.hasProcessing) return
      const controller: PollController = { failures: 0, ownerEpoch: this._ownerEpoch }
      pollingControllers.set(this, controller)
      const schedule = (delay: number) => {
        controller.timer = globalThis.setTimeout(async () => {
          if (pollingControllers.get(this) !== controller
            || controller.ownerEpoch !== this._ownerEpoch) return
          let succeeded: boolean
          try {
            succeeded = await this.refreshProcessing()
          } catch {
            succeeded = false
          }
          if (pollingControllers.get(this) !== controller
            || controller.ownerEpoch !== this._ownerEpoch) return
          if (succeeded) {
            controller.failures = 0
            this.pollingError = ''
            if (this.hasProcessing) schedule(POLL_INTERVAL_MS)
            else pollingControllers.delete(this)
            return
          }
          controller.failures += 1
          if (controller.failures >= MAX_POLL_FAILURES) {
            this.pollingError = '处理状态自动刷新已暂停，请重新进入知识库后重试。'
            pollingControllers.delete(this)
            return
          }
          schedule(POLL_INTERVAL_MS * (2 ** controller.failures))
        }, delay)
      }
      schedule(POLL_INTERVAL_MS)
    },
    stopProcessingPolling() {
      const controller = pollingControllers.get(this)
      if (controller?.timer !== undefined) globalThis.clearTimeout(controller.timer)
      pollingControllers.delete(this)
      this._catalogVersion += 1
      this._refreshVersion += 1
      this._documentLoadVersions = {}
      this._versionLoadVersions = {}
      this._documentsLoadingVersion += 1
      this._versionsLoadingVersion += 1
      this.loading = false
      this.documentsLoading = false
      this.versionsLoading = false
    },
    async runOperation(message: string, operation: (isCurrent: () => boolean) => Promise<void>) {
      const ownerEpoch = this._ownerEpoch
      const version = ++this._operationVersion
      const isCurrent = () => ownerEpoch === this._ownerEpoch && version === this._operationVersion
      this.operationPending = true
      this.operationError = ''
      try {
        await operation(isCurrent)
        if (isCurrent()) this.operationError = ''
      } catch (error) {
        if (isCurrent()) this.operationError = displayError(error, message)
      } finally {
        if (isCurrent()) this.operationPending = false
      }
    },
  },
})

if (import.meta.hot) import.meta.hot.accept(acceptHMRUpdate(useKnowledgeStore, import.meta.hot))
