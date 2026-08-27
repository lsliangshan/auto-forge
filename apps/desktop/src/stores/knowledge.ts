import { acceptHMRUpdate, defineStore } from 'pinia'
import type {
  KnowledgeAvailability,
  KnowledgeBaseSummary,
  KnowledgeDocumentSummary,
  KnowledgeEntitlementState,
  KnowledgeVersionSummary,
} from '@autoforge/shared'
import { displayError, getDesktopApi } from '../services/desktop-api'

const refreshes = new WeakMap<object, Promise<void>>()
const releases = new WeakMap<object, () => void>()
const timers = new WeakMap<object, ReturnType<typeof setTimeout>>()
const MAX_POLL_DELAY_MS = 15_000

function clearTimer(store: object): void {
  const timer = timers.get(store)
  if (timer !== undefined) clearTimeout(timer)
  timers.delete(store)
}

export const useKnowledgeStore = defineStore('knowledge', {
  state: () => ({
    ownerId: '' as string,
    bases: [] as KnowledgeBaseSummary[],
    documents: [] as KnowledgeDocumentSummary[],
    versions: [] as KnowledgeVersionSummary[],
    selectedBaseId: '' as string,
    selectedDocumentId: '' as string,
    availability: undefined as KnowledgeAvailability | undefined,
    entitlement: undefined as KnowledgeEntitlementState | undefined,
    loading: false,
    busy: false,
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
  },
  actions: {
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
      this.selectedBaseId = ''
      this.selectedDocumentId = ''
      this.availability = undefined
      this.entitlement = undefined
      this.loading = false
      this.busy = false
      this.error = ''
      this._pollDelayMs = 1_000
    },
    async bindOwner(ownerId: string | undefined) {
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
        }
        return
      }
      const documents = await getDesktopApi().knowledge.listDocuments(baseId)
      if (expectedEpoch !== this._epoch || baseId !== this.selectedBaseId) return
      this.documents = documents
      if (!documents.some(({ id }) => id === this.selectedDocumentId)) {
        this.selectedDocumentId = documents[0]?.id ?? ''
      }
      await this.loadVersions(this.selectedDocumentId, expectedEpoch)
    },
    async selectBase(baseId: string) {
      if (baseId === this.selectedBaseId) return
      this.selectedBaseId = baseId
      this.documents = []
      this.selectedDocumentId = ''
      this.versions = []
      try {
        await this.loadDocuments(baseId)
      } catch (error) {
        if (baseId === this.selectedBaseId) this.error = displayError(error, '文档加载失败')
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
      this.selectedDocumentId = documentId
      this.versions = []
      try {
        await this.loadVersions(documentId)
      } catch (error) {
        if (documentId === this.selectedDocumentId) this.error = displayError(error, '版本加载失败')
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
    async createBase(name: string) {
      const clean = name.trim()
      if (!clean || this.busy) return
      this.busy = true
      this.error = ''
      try {
        const created = await getDesktopApi().knowledge.create(clean)
        await this.refresh()
        await this.selectBase(created.id)
      } catch (error) {
        this.error = displayError(error, '知识库创建失败')
      } finally {
        this.busy = false
      }
    },
    async importDocuments() {
      const baseId = this.selectedBaseId
      if (!baseId || this.busy) return
      this.busy = true
      this.error = ''
      try {
        const handles = await getDesktopApi().knowledge.pickImportFiles()
        for (const handle of handles) {
          await getDesktopApi().knowledge.importDocument(baseId, handle.id)
        }
        await this.loadDocuments(baseId)
        this.schedulePolling()
      } catch (error) {
        this.error = displayError(error, '文档导入失败')
      } finally {
        this.busy = false
      }
    },
    async replaceDocument() {
      const documentId = this.selectedDocumentId
      if (!documentId || this.busy) return
      this.busy = true
      try {
        const handle = (await getDesktopApi().knowledge.pickImportFiles())[0]
        if (handle) await getDesktopApi().knowledge.replaceDocument(documentId, handle.id)
        await this.loadDocuments(this.selectedBaseId)
        this.schedulePolling()
      } catch (error) {
        this.error = displayError(error, '文档替换失败')
      } finally {
        this.busy = false
      }
    },
    async runDocumentAction(action: 'recycle' | 'restore' | 'purge') {
      const documentId = this.selectedDocumentId
      if (!documentId || this.busy) return
      this.busy = true
      try {
        const api = getDesktopApi().knowledge
        if (action === 'recycle') await api.recycleDocument(documentId)
        else if (action === 'restore') await api.restoreDocument(documentId)
        else await api.purgeDocument(documentId)
        await this.loadDocuments(this.selectedBaseId)
      } catch (error) {
        this.error = displayError(error, '文档操作失败')
      } finally {
        this.busy = false
      }
    },
    async runBaseAction(action: 'recycle' | 'restore' | 'purge' | 'export') {
      const baseId = this.selectedBaseId
      if (!baseId || this.busy) return
      this.busy = true
      try {
        const api = getDesktopApi().knowledge
        if (action === 'recycle') await api.recycleBase(baseId)
        else if (action === 'restore') await api.restoreBase(baseId)
        else if (action === 'purge') await api.purgeBase(baseId)
        else await api.exportBase(baseId)
        if (action !== 'export') await this.refresh()
      } catch (error) {
        this.error = displayError(error, '知识库操作失败')
      } finally {
        this.busy = false
      }
    },
  },
})

if (import.meta.hot) import.meta.hot.accept(acceptHMRUpdate(useKnowledgeStore, import.meta.hot))
