import { acceptHMRUpdate, defineStore } from 'pinia'
import type { DesktopAPI, ExecutionDetail, ExecutionEvent, ExecutionQuery, ExecutionSummary } from '@autoforge/shared'
import { displayError, getDesktopApi } from '../services/desktop-api'

interface ExecutionHub { listeners: Set<(event: ExecutionEvent) => void>; unsubscribe: () => void }
interface SequencedExecutionEvent { sequence: number; event: ExecutionEvent }
const hubs = new WeakMap<DesktopAPI, ExecutionHub>()
const storeReleases = new WeakMap<object, () => void>()
const disposeWrapped = new WeakSet<object>()
function acquireExecutionEvents(api: DesktopAPI, listener: (event: ExecutionEvent) => void): () => void {
  const existing = hubs.get(api)
  const hub: ExecutionHub = existing ?? { listeners: new Set(), unsubscribe: () => undefined }
  if (!existing) {
    hub.unsubscribe = api.executions.onEvent((event) => { for (const listener of hub.listeners) listener(event) })
    hubs.set(api, hub)
  }
  hub.listeners.add(listener)
  let active = true
  return () => {
    if (!active) return
    active = false
    hub.listeners.delete(listener)
    if (!hub.listeners.size) { hub.unsubscribe(); hubs.delete(api) }
  }
}

export const useExecutionStore = defineStore('execution', {
  state: () => ({
    items: [] as ExecutionSummary[], details: {} as Record<string, ExecutionDetail>, selectedId: '',
    query: {} as ExecutionQuery, loading: false, detailLoadingById: {} as Record<string, boolean>, error: '',
    _listVersion: 0, _detailVersions: {} as Record<string, number>, _subscribed: false,
    _eventSequence: 0, _eventHistory: [] as SequencedExecutionEvent[],
  }),
  getters: {
    selectedDetail(state): ExecutionDetail | undefined { return state.details[state.selectedId] },
    selectedDetailLoading(state): boolean { return Boolean(state.detailLoadingById[state.selectedId]) },
  },
  actions: {
    resetLocalData() {
      this._listVersion += 1
      this.items = []
      this.details = {}
      this.selectedId = ''
      this.query = {}
      this.detailLoadingById = {}
      this.loading = false
      this.error = ''
    },
    ensureSubscription() {
      if (this._subscribed) return
      this._subscribed = true
      const release = acquireExecutionEvents(getDesktopApi(), (event) => this.applyEvent(event))
      storeReleases.set(this, release)
      if (!disposeWrapped.has(this)) {
        disposeWrapped.add(this)
        const dispose = this.$dispose.bind(this)
        this.$dispose = () => {
          storeReleases.get(this)?.()
          storeReleases.delete(this)
          this._subscribed = false
          dispose()
        }
      }
    },
    async load(query?: ExecutionQuery) {
      this.ensureSubscription()
      this.query = { ...(query ?? this.query) }
      const version = ++this._listVersion
      this.loading = true
      const eventSequence = this._eventSequence
      this.error = ''
      try {
        const items = await getDesktopApi().executions.list(this.query)
        if (version !== this._listVersion) return
        this.items = items
        for (const entry of this._eventHistory) {
          if (entry.sequence > eventSequence) this._applyEvent(entry.event)
        }
        if (this.selectedId && !items.some(({ id }) => id === this.selectedId)) this.selectedId = ''
      } catch (error) { if (version === this._listVersion) this.error = displayError(error, '执行记录加载失败') }
      finally {
        if (version === this._listVersion) this.loading = false
        if (!this.loading && !Object.values(this.detailLoadingById).some(Boolean)) this._eventHistory = []
      }
    },
    async select(id: string) {
      this.selectedId = id
      await this.loadDetail(id)
    },
    async loadDetail(id: string) {
      this.ensureSubscription()
      const version = (this._detailVersions[id] ?? 0) + 1
      this._detailVersions[id] = version
      this.detailLoadingById[id] = true
      const eventSequence = this._eventSequence
      this.error = ''
      try {
        const detail = await getDesktopApi().executions.get(id)
        if (version === this._detailVersions[id]) {
          this.details[id] = detail
          for (const entry of this._eventHistory) {
            if (entry.sequence > eventSequence && entry.event.executionId === id) this._applyEvent(entry.event)
          }
        }
      } catch (error) { if (version === this._detailVersions[id]) this.error = displayError(error, '执行详情加载失败') }
      finally {
        if (version === this._detailVersions[id]) this.detailLoadingById[id] = false
        if (!this.loading && !Object.values(this.detailLoadingById).some(Boolean)) this._eventHistory = []
      }
    },
    async cancel(id: string) {
      try { await getDesktopApi().executions.cancel(id) }
      catch (error) { this.error = displayError(error, '取消执行失败') }
    },
    applyEvent(event: ExecutionEvent) {
      this._eventSequence += 1
      if (this.loading || Object.values(this.detailLoadingById).some(Boolean)) this._eventHistory.push({ sequence: this._eventSequence, event })
      this._applyEvent(event)
    },
    _applyEvent(event: ExecutionEvent) {
      const summary = this.items.find(({ id }) => id === event.executionId)
      const detail = this.details[event.executionId]
      if (event.type === 'status') {
        if (summary) summary.status = event.status
        if (detail) {
          detail.status = event.status
          if (event.error) detail.error = event.error
        }
      } else if (event.type === 'log' && detail) {
        const id = `${event.executionId}:log:${event.occurredAt}:${event.level}:${event.message}`
        if (!detail.logs.some((log) => log.id === id)) detail.logs.push({ id, level: event.level, message: event.message, createdAt: event.occurredAt })
      } else if (event.type === 'step' && detail) {
        const step = detail.steps.find(({ id }) => id === event.stepId)
        if (step) Object.assign(step, { label: event.label, status: event.status })
        else detail.steps.push({ id: event.stepId, label: event.label, status: event.status, startedAt: event.occurredAt })
      } else if (event.type === 'result' && detail) detail.output = event.summary
    },
  },
})

if (import.meta.hot) import.meta.hot.accept(acceptHMRUpdate(useExecutionStore, import.meta.hot))
