import { acceptHMRUpdate, defineStore } from 'pinia'
import type {
  KnowledgeAvailability,
  KnowledgeBaseSummary,
  KnowledgeDocumentPreview,
  KnowledgeDocumentSummary,
  KnowledgeEntitlementState,
  KnowledgeVersionSummary,
} from '@autoforge/shared'
import { displayError, getDesktopApi } from '../services/desktop-api'

const refreshes = new WeakMap<object, Promise<void>>()
const releases = new WeakMap<object, () => void>()
const timers = new WeakMap<object, ReturnType<typeof setTimeout>>()
const disposeWrapped = new WeakSet<object>()
const MAX_POLL_DELAY_MS = 15_000
export const KNOWLEDGE_DOCUMENT_LIMIT_MESSAGE = '当前会员版本的文件数量已达上限；回收站、处理失败和处理中条目也会计入，请永久删除后重试'

interface OwnerToken {
  readonly ownerId: string
  readonly epoch: number
}

function clearTimer(store: object): void {
  const timer = timers.get(store)
  if (timer !== undefined) clearTimeout(timer)
  timers.delete(store)
}

function releaseDocumentPreview(preview: KnowledgeDocumentPreview | undefined): void {
  if (preview?.kind !== 'original') return
  try { preview.bytes.fill(0) } catch { /* The backing buffer may already be detached. */ }
}

export const useKnowledgeStore = defineStore('knowledge', {
  state: () => ({
    ownerId: '' as string,
    bases: [] as KnowledgeBaseSummary[],
    documents: [] as KnowledgeDocumentSummary[],
    versions: [] as KnowledgeVersionSummary[],
    documentPreview: undefined as KnowledgeDocumentPreview | undefined,
    previewLoading: false,
    selectedBaseId: '' as string,
    selectedDocumentId: '' as string,
    availability: undefined as KnowledgeAvailability | undefined,
    entitlement: undefined as KnowledgeEntitlementState | undefined,
    loading: false,
    _pendingOperations: 0,
    error: '',
    _epoch: 0,
    _pollDelayMs: 1_000,
  }),
  getters: {
    selectedBase(state): KnowledgeBaseSummary | undefined {
      return state.bases.find(({ id }) => id === state.selectedBaseId)
    },
    selectedDocument(state): KnowledgeDocumentSummary | undefined {
      return state.documents.find(({ id }) => id === state.selectedDocumentId)
    },
    hasActiveJobs(state): boolean {
      return state.documents.some(({ status }) => ['queued', 'copying', 'parsing', 'indexing'].includes(status))
    },
    busy(state): boolean {
      return state._pendingOperations > 0
    },
    localAvailable(state): boolean {
      return state.entitlement?.localEnabled === true
        && state.availability?.encryption.available === true
        && state.availability?.parser.available === true
    },
    baseLimitReached(state): boolean {
      const limit = state.entitlement?.limits?.knowledgeBases
        ?? (state.entitlement?.tier === 'member' ? 20 : 1)
      return state.bases.length >= limit
    },
    documentLimitReached(state): boolean {
      const limit = state.entitlement?.limits?.knowledgeDocuments
        ?? (state.entitlement?.tier === 'member' ? 500 : 1)
      return state.bases.reduce((total, base) => total + base.documentCount, 0) >= limit
    },
  },
  actions: {
    clearDocumentPreview() {
      releaseDocumentPreview(this.documentPreview)
      this.documentPreview = undefined
    },
    resetLocalData() {
      this._epoch += 1
      clearTimer(this)
      releases.get(this)?.()
      releases.delete(this)
      refreshes.delete(this)
      this.ownerId = ''
      this.bases = []
      this.documents = []
      this.versions = []
      this.clearDocumentPreview()
      this.previewLoading = false
      this.selectedBaseId = ''
      this.selectedDocumentId = ''
      this.availability = undefined
      this.entitlement = undefined
      this.loading = false
      this._pendingOperations = 0
      this.error = ''
      this._pollDelayMs = 1_000
    },
    async bindOwner(ownerId: string | undefined) {
      if (!disposeWrapped.has(this)) {
        const dispose = this.$dispose.bind(this)
        this.$dispose = () => {
          this.resetLocalData()
          dispose()
        }
        disposeWrapped.add(this)
      }
      if (!ownerId) {
        this.resetLocalData()
        return
      }
      if (this.ownerId !== ownerId) {
        this.resetLocalData()
        this.ownerId = ownerId
        const epoch = this._epoch
        releases.set(this, getDesktopApi().knowledge.onEvent(() => {
          if (epoch === this._epoch) void this.refresh()
        }))
      }
      await this.refresh()
    },
    refresh(): Promise<void> {
      const pending = refreshes.get(this)
      if (pending) return pending
      const epoch = this._epoch
      const ownerId = this.ownerId
      if (!ownerId) return Promise.resolve()
      this.loading = true
      this.error = ''
      const operation = (async () => {
        try {
          const api = getDesktopApi().knowledge
          const [bases, availability, entitlement] = await Promise.all([
            api.list(), api.getAvailability(), api.getEntitlement(),
          ])
          if (epoch !== this._epoch || ownerId !== this.ownerId) return
          this.bases = bases
          if (!bases.some(({ id }) => id === this.selectedBaseId)) {
            this.selectedBaseId = bases[0]?.id ?? ''
          }
          this.availability = availability
          this.entitlement = entitlement
          await this.loadDocuments(this.selectedBaseId, epoch)
          if (epoch !== this._epoch || ownerId !== this.ownerId) return
          this._pollDelayMs = 1_000
          this.schedulePolling()
        } catch (error) {
          if (epoch !== this._epoch || ownerId !== this.ownerId) return
          this.error = displayError(error, '知识库加载失败')
          this._pollDelayMs = Math.min(this._pollDelayMs * 2, MAX_POLL_DELAY_MS)
          this.schedulePolling()
        } finally {
          if (epoch === this._epoch && ownerId === this.ownerId) this.loading = false
        }
      })()
      refreshes.set(this, operation)
      void operation.finally(() => {
        if (refreshes.get(this) === operation) refreshes.delete(this)
      })
      return operation
    },
    async loadDocuments(baseId: string, epoch?: number) {
      const expectedEpoch = epoch ?? this._epoch
      if (!baseId) {
        if (expectedEpoch === this._epoch) {
          this.documents = []
          this.selectedDocumentId = ''
          this.versions = []
          this.clearDocumentPreview()
          this.previewLoading = false
        }
        return
      }
      const documents = await getDesktopApi().knowledge.listDocuments(baseId)
      if (expectedEpoch !== this._epoch || baseId !== this.selectedBaseId) return
      this.documents = documents
      if (!documents.some(({ id }) => id === this.selectedDocumentId)) {
        this.selectedDocumentId = documents[0]?.id ?? ''
      }
      await Promise.all([
        this.loadVersions(this.selectedDocumentId, expectedEpoch),
        this.loadDocumentPreview(this.selectedDocumentId, expectedEpoch),
      ])
    },
    async selectBase(baseId: string) {
      if (baseId === this.selectedBaseId) return
      const epoch = this._epoch
      const ownerId = this.ownerId
      this.selectedBaseId = baseId
      this.documents = []
      this.selectedDocumentId = ''
      this.versions = []
      this.clearDocumentPreview()
      this.previewLoading = false
      try {
        await this.loadDocuments(baseId, epoch)
      } catch (error) {
        if (epoch === this._epoch && ownerId === this.ownerId && baseId === this.selectedBaseId) {
          this.error = displayError(error, '文档加载失败')
        }
      }
    },
    async loadVersions(documentId: string, epoch?: number) {
      const expectedEpoch = epoch ?? this._epoch
      if (!documentId) {
        if (expectedEpoch === this._epoch) this.versions = []
        return
      }
      const versions = await getDesktopApi().knowledge.listVersions(documentId)
      if (expectedEpoch === this._epoch && documentId === this.selectedDocumentId) this.versions = versions
    },
    async selectDocument(documentId: string) {
      const epoch = this._epoch
      const ownerId = this.ownerId
      this.selectedDocumentId = documentId
      this.versions = []
      this.clearDocumentPreview()
      try {
        await Promise.all([
          this.loadVersions(documentId, epoch),
          this.loadDocumentPreview(documentId, epoch),
        ])
      } catch (error) {
        if (epoch === this._epoch && ownerId === this.ownerId && documentId === this.selectedDocumentId) {
          this.error = displayError(error, '版本加载失败')
        }
      }
    },
    async loadDocumentPreview(documentId: string, epoch?: number) {
      const expectedEpoch = epoch ?? this._epoch
      if (!documentId) {
        if (expectedEpoch === this._epoch) {
          this.clearDocumentPreview()
          this.previewLoading = false
        }
        return
      }
      this.previewLoading = true
      try {
        const preview = await getDesktopApi().knowledge.getDocumentPreview(documentId)
        if (expectedEpoch === this._epoch && documentId === this.selectedDocumentId) {
          this.clearDocumentPreview()
          this.documentPreview = preview
        } else {
          releaseDocumentPreview(preview)
        }
      } catch {
        if (expectedEpoch === this._epoch && documentId === this.selectedDocumentId) {
          this.documentPreview = { kind: 'unavailable' }
        }
      } finally {
        if (expectedEpoch === this._epoch && documentId === this.selectedDocumentId) {
          this.previewLoading = false
        }
      }
    },
    schedulePolling() {
      clearTimer(this)
      if (!this.ownerId || !this.hasActiveJobs) return
      const epoch = this._epoch
      timers.set(this, setTimeout(() => {
        timers.delete(this)
        if (epoch === this._epoch) void this.refresh()
      }, this._pollDelayMs))
    },
    captureOwnerToken(): OwnerToken | undefined {
      if (!this.ownerId) return undefined
      return Object.freeze({ ownerId: this.ownerId, epoch: this._epoch })
    },
    isOwnerTokenCurrent(token: OwnerToken): boolean {
      return token.epoch === this._epoch && token.ownerId === this.ownerId
    },
    beginOperation(): OwnerToken | undefined {
      if (this.busy) return undefined
      const operation = this.captureOwnerToken()
      if (!operation) return undefined
      this._pendingOperations += 1
      this.error = ''
      return operation
    },
    ownsOperation(operation: OwnerToken): boolean {
      return this.isOwnerTokenCurrent(operation)
    },
    finishOperation(operation: OwnerToken): void {
      if (!this.ownsOperation(operation)) return
      this._pendingOperations = Math.max(0, this._pendingOperations - 1)
    },
    async createBase(name: string) {
      const clean = name.trim()
      if (!clean) return
      const operation = this.beginOperation()
      if (!operation) return
      try {
        const created = await getDesktopApi().knowledge.create(clean)
        if (!this.ownsOperation(operation)) return
        await this.refresh()
        if (!this.ownsOperation(operation)) return
        await this.selectBase(created.id)
      } catch (error) {
        if (this.ownsOperation(operation)) this.error = displayError(error, '知识库创建失败')
      } finally {
        this.finishOperation(operation)
      }
    },
    async importDocuments() {
      const baseId = this.selectedBaseId
      if (!baseId) return
      if (this.documentLimitReached) {
        this.error = KNOWLEDGE_DOCUMENT_LIMIT_MESSAGE
        return
      }
      const operation = this.beginOperation()
      if (!operation) return
      try {
        const handles = await getDesktopApi().knowledge.pickImportFiles()
        if (!this.ownsOperation(operation)) return
        for (const handle of handles) {
          await getDesktopApi().knowledge.importDocument(baseId, handle.id)
          if (!this.ownsOperation(operation)) return
        }
        await this.loadDocuments(baseId, operation.epoch)
        if (!this.ownsOperation(operation)) return
        this.schedulePolling()
      } catch (error) {
        if (this.ownsOperation(operation)) this.error = displayError(error, '文档导入失败')
      } finally {
        this.finishOperation(operation)
      }
    },
    async replaceDocument() {
      const documentId = this.selectedDocumentId
      if (!documentId) return
      const operation = this.beginOperation()
      if (!operation) return
      try {
        const handle = (await getDesktopApi().knowledge.pickImportFiles())[0]
        if (!this.ownsOperation(operation)) return
        if (handle) {
          await getDesktopApi().knowledge.replaceDocument(documentId, handle.id)
          if (!this.ownsOperation(operation)) return
        }
        await this.loadDocuments(this.selectedBaseId, operation.epoch)
        if (!this.ownsOperation(operation)) return
        this.schedulePolling()
      } catch (error) {
        if (this.ownsOperation(operation)) this.error = displayError(error, '文档替换失败')
      } finally {
        this.finishOperation(operation)
      }
    },
    async runDocumentAction(action: 'recycle' | 'restore' | 'purge') {
      const documentId = this.selectedDocumentId
      if (!documentId) return
      const operation = this.beginOperation()
      if (!operation) return
      try {
        const api = getDesktopApi().knowledge
        if (action === 'recycle') await api.recycleDocument(documentId)
        else if (action === 'restore') await api.restoreDocument(documentId)
        else await api.purgeDocument(documentId)
        if (!this.ownsOperation(operation)) return
        await this.loadDocuments(this.selectedBaseId, operation.epoch)
      } catch (error) {
        if (this.ownsOperation(operation)) this.error = displayError(error, '文档操作失败')
      } finally {
        this.finishOperation(operation)
      }
    },
    async runBaseAction(action: 'recycle' | 'restore' | 'purge' | 'export') {
      const baseId = this.selectedBaseId
      if (!baseId) return
      const operation = this.beginOperation()
      if (!operation) return
      try {
        const api = getDesktopApi().knowledge
        if (action === 'recycle') await api.recycleBase(baseId)
        else if (action === 'restore') await api.restoreBase(baseId)
        else if (action === 'purge') await api.purgeBase(baseId)
        else await api.exportBase(baseId)
        if (!this.ownsOperation(operation)) return
        if (action !== 'export') {
          await this.refresh()
          if (!this.ownsOperation(operation)) return
        }
      } catch (error) {
        if (this.ownsOperation(operation)) this.error = displayError(error, '知识库操作失败')
      } finally {
        this.finishOperation(operation)
      }
    },
    async retainSelectedForFreeTier() {
      const baseId = this.selectedBaseId
      const documentId = this.selectedDocumentId
      if (!baseId || !documentId) return
      const operation = this.beginOperation()
      if (!operation) return
      try {
        const entitlement = await getDesktopApi().knowledge.retainFreeAllowance({ baseId, documentId })
        if (!this.ownsOperation(operation)) return
        this.entitlement = entitlement
        await this.refresh()
      } catch (error) {
        if (this.ownsOperation(operation)) this.error = displayError(error, '保留项设置失败')
      } finally {
        this.finishOperation(operation)
      }
    },
  },
})

if (import.meta.hot) import.meta.hot.accept(acceptHMRUpdate(useKnowledgeStore, import.meta.hot))
