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
    _loadVersion: 0,
    _documentLoadVersions: {} as Record<string, number>,
    _versionLoadVersion: 0,
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
    canWrite(state): boolean {
      const base = state.bases.find(({ id }) => id === state.selectedBaseId)
      if (!base || base.status === 'read_only' || base.status === 'recycled') return false
      if (base.kind === 'local') return Boolean(state.availability?.local.available)
      return Boolean(
        state.availability?.cloud.available
        && state.entitlement?.cloudEnabled
        && ['active', 'offline_grace'].includes(state.entitlement.status),
      )
    },
  },
  actions: {
    reset() {
      this._loadVersion += 1
      this._documentLoadVersions = {}
      this._versionLoadVersion += 1
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
    },
    async load() {
      const version = ++this._loadVersion
      this.loading = true
      this.error = ''
      try {
        const api = getDesktopApi().knowledge
        const availability = await api.getFeatureAvailability()
        if (version !== this._loadVersion) return
        this.availability = availability
        const [entitlement, consent] = await Promise.all([
          api.getEntitlement(),
          api.getConsent(),
        ])
        if (version !== this._loadVersion) return
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
        if (version !== this._loadVersion) return
        this.bases = bases
        if (!bases.some(({ id }) => id === this.selectedBaseId)) {
          this.selectedBaseId = bases[0]?.id ?? ''
          this.selectedDocumentId = ''
        }
        if (this.selectedBaseId) await this.loadDocuments(this.selectedBaseId)
      } catch (error) {
        if (version === this._loadVersion) this.error = displayError(error, '知识库加载失败')
      } finally {
        if (version === this._loadVersion) this.loading = false
      }
    },
    async loadSelectorCatalog() {
      try {
        const api = getDesktopApi().knowledge
        const availability = await api.getFeatureAvailability()
        this.availability = availability
        const [entitlement, consent] = await Promise.all([
          api.getEntitlement(),
          api.getConsent(),
        ])
        this.entitlement = entitlement
        this.consent = consent
        if (!availability.local.available && !availability.cloud.available) {
          this.bases = []
          return
        }
        this.bases = await api.listBases()
      } catch (error) {
        this.operationError = displayError(error, '知识库选项加载失败')
        this.bases = []
      }
    },
    async refreshCatalog() {
      const bases = await getDesktopApi().knowledge.listBases()
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
    async loadDocuments(requestedKnowledgeBaseId?: string) {
      const knowledgeBaseId = requestedKnowledgeBaseId ?? this.selectedBaseId
      if (!knowledgeBaseId) return
      const version = (this._documentLoadVersions[knowledgeBaseId] ?? 0) + 1
      this._documentLoadVersions[knowledgeBaseId] = version
      this.documentsLoading = true
      try {
        const documents = await getDesktopApi().knowledge.listDocuments(knowledgeBaseId)
        if (version !== this._documentLoadVersions[knowledgeBaseId]) return
        this.documentsByBase[knowledgeBaseId] = documents
        if (this.selectedBaseId === knowledgeBaseId
          && !documents.some(({ id }) => id === this.selectedDocumentId)) {
          this.selectedDocumentId = ''
        }
      } catch (error) {
        if (version === this._documentLoadVersions[knowledgeBaseId]) {
          this.operationError = displayError(error, '文件列表加载失败')
        }
      } finally {
        if (version === this._documentLoadVersions[knowledgeBaseId]) this.documentsLoading = false
      }
    },
    async selectDocument(id: string) {
      this.selectedDocumentId = id
      await this.loadVersions(id)
    },
    async loadVersions(requestedDocumentId?: string) {
      const documentId = requestedDocumentId ?? this.selectedDocumentId
      if (!documentId) return
      const version = ++this._versionLoadVersion
      this.versionsLoading = true
      try {
        const versions = await getDesktopApi().knowledge.listVersions(documentId)
        if (version === this._versionLoadVersion && this.selectedDocumentId === documentId) {
          this.versionsByDocument[documentId] = versions
        }
      } catch (error) {
        if (version === this._versionLoadVersion) {
          this.operationError = displayError(error, '版本列表加载失败')
        }
      } finally {
        if (version === this._versionLoadVersion) this.versionsLoading = false
      }
    },
    async createBase(rawName: string) {
      const name = rawName.trim()
      if (!name || this.operationPending) return
      await this.runOperation('创建知识库失败', async () => {
        const created = await getDesktopApi().knowledge.createBase(name)
        this.bases = [created, ...this.bases.filter(({ id }) => id !== created.id)]
        this.selectedBaseId = created.id
        this.selectedDocumentId = ''
        this.documentsByBase[created.id] = []
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
      if (!this.selectedBaseId || this.operationPending || !this.canWrite) return
      await this.runOperation('导入文件失败', async () => {
        const acknowledgement = await getDesktopApi().knowledge.importDocument(this.selectedBaseId)
        if (acknowledgement) this.upsertDocument(acknowledgement)
      })
    },
    async replaceSelectedDocument() {
      const documentId = this.selectedDocumentId
      if (!documentId || this.operationPending || !this.canWrite) return
      await this.runOperation('替换文件失败', async () => {
        const acknowledgement = await getDesktopApi().knowledge.replaceDocument(documentId)
        if (acknowledgement) this.upsertDocument(acknowledgement)
      })
    },
    async recycleSelectedDocument() {
      const document = this.selectedDocument
      if (!document || this.operationPending) return
      await this.runOperation('移入回收站失败', async () => {
        await getDesktopApi().knowledge.recycleDocument(document.id)
        this.documentsByBase[document.knowledgeBaseId] = this.documents
          .filter(({ id }) => id !== document.id)
        this.selectedDocumentId = ''
      })
    },
    async exportSelectedBase() {
      if (!this.selectedBaseId || this.operationPending) return
      await this.runOperation('导出知识库失败', () =>
        getDesktopApi().knowledge.exportBase(this.selectedBaseId))
    },
    async recycleSelectedBase() {
      const baseId = this.selectedBaseId
      if (!baseId || this.operationPending) return
      await this.runOperation('移入回收站失败', async () => {
        await getDesktopApi().knowledge.recycleBase(baseId)
        this.bases = this.bases.filter(({ id }) => id !== baseId)
        delete this.documentsByBase[baseId]
        this.selectedBaseId = this.bases[0]?.id ?? ''
        this.selectedDocumentId = ''
        if (this.selectedBaseId) await this.loadDocuments(this.selectedBaseId)
      })
    },
    async refreshProcessing() {
      if (!this.hasProcessing) return
      const selectedDocumentId = this.selectedDocumentId
      await Promise.all(Object.entries(this.documentsByBase)
        .filter(([, documents]) => documents.some(({ status }) => processingDocumentStatuses.has(status)))
        .map(([baseId]) => this.loadDocuments(baseId)))
      if (selectedDocumentId && this.selectedDocumentId === selectedDocumentId) {
        await this.loadVersions(selectedDocumentId)
      }
      const bases = await getDesktopApi().knowledge.listBases()
      this.bases = bases
    },
    async runOperation(message: string, operation: () => Promise<void>) {
      this.operationPending = true
      this.operationError = ''
      try {
        await operation()
      } catch (error) {
        this.operationError = displayError(error, message)
      } finally {
        this.operationPending = false
      }
    },
  },
})

if (import.meta.hot) import.meta.hot.accept(acceptHMRUpdate(useKnowledgeStore, import.meta.hot))
