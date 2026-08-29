import { acceptHMRUpdate, defineStore } from 'pinia'
import type { ConversionArtifactView, ConversionJobEvent, ConversionJobView, DesktopAPI } from '@autoforge/shared'
import { displayError, getDesktopApi } from '../services/desktop-api'

interface ConversionHub { listeners: Set<(event: ConversionJobEvent) => void>; unsubscribe: () => void }

const hubs = new WeakMap<DesktopAPI, ConversionHub>()
const storeReleases = new WeakMap<object, () => void>()
const disposeWrapped = new WeakSet<object>()

function acquireConversionEvents(api: DesktopAPI, listener: (event: ConversionJobEvent) => void): () => void {
  const existing = hubs.get(api)
  const hub: ConversionHub = existing ?? { listeners: new Set(), unsubscribe: () => undefined }
  if (!existing) {
    hub.unsubscribe = api.conversion.onEvent((event) => { for (const current of hub.listeners) current(event) })
    hubs.set(api, hub)
  }
  hub.listeners.add(listener)
  let active = true
  return () => {
    if (!active) return
    active = false
    hub.listeners.delete(listener)
    if (!hub.listeners.size) {
      hub.unsubscribe()
      hubs.delete(api)
    }
  }
}

function statusRank(status: ConversionJobView['status']): number {
  return ({
    queued: 0, downloading_component: 1, converting: 2, verifying: 3,
    completed: 4, failed: 4, cancelled: 4, interrupted: 4,
  })[status]
}

function isTerminal(status: ConversionJobView['status']): boolean {
  return statusRank(status) === 4
}

function newerJob(current: ConversionJobView | undefined, candidate: ConversionJobView): ConversionJobView {
  if (!current || candidate.epoch > current.epoch) return candidate
  if (candidate.epoch < current.epoch) return current
  const currentRank = statusRank(current.status)
  const candidateRank = statusRank(candidate.status)
  if (candidateRank > currentRank) return candidate
  if (candidateRank < currentRank) return current
  if (isTerminal(current.status) && current.status !== candidate.status) return current
  if (candidate.progress < current.progress && !isTerminal(candidate.status)) return current
  return candidate
}

function mergeJobs(current: ConversionJobView[], incoming: ConversionJobView[]): ConversionJobView[] {
  const jobs = new Map(current.map((job) => [job.jobId, job]))
  for (const job of incoming) jobs.set(job.jobId, newerJob(jobs.get(job.jobId), job))
  return [...jobs.values()].sort((left, right) => left.jobId.localeCompare(right.jobId))
}

export const useConversionStore = defineStore('conversion', {
  state: () => ({
    jobsByExecution: {} as Record<string, ConversionJobView[]>,
    loadingByExecution: {} as Record<string, boolean>,
    errorsByExecution: {} as Record<string, string>,
    pendingArtifactIds: {} as Record<string, true>,
    actionErrorsByArtifact: {} as Record<string, string>,
    _loadVersions: {} as Record<string, number>,
    _stateEpoch: 0,
    _subscribed: false,
    _subscriptionUsers: 0,
  }),
  actions: {
    jobsForExecution(executionId: string): ConversionJobView[] {
      return this.jobsByExecution[executionId] ?? []
    },
    resetLocalData() {
      this._stateEpoch += 1
      storeReleases.get(this)?.()
      storeReleases.delete(this)
      this._subscribed = false
      this._subscriptionUsers = 0
      this.jobsByExecution = {}
      this.loadingByExecution = {}
      this.errorsByExecution = {}
      this.pendingArtifactIds = {}
      this.actionErrorsByArtifact = {}
      this._loadVersions = {}
    },
    ensureSubscription() {
      if (this._subscribed) return
      this._subscribed = true
      storeReleases.set(this, acquireConversionEvents(getDesktopApi(), (event) => this.applyEvent(event)))
      if (!disposeWrapped.has(this)) {
        disposeWrapped.add(this)
        const dispose = this.$dispose.bind(this)
        this.$dispose = () => {
          this.resetLocalData()
          dispose()
        }
      }
    },
    acquireSubscription(): () => void {
      this.ensureSubscription()
      this._subscriptionUsers += 1
      let released = false
      return () => {
        if (released) return
        released = true
        this._subscriptionUsers = Math.max(0, this._subscriptionUsers - 1)
        if (this._subscriptionUsers === 0) {
          storeReleases.get(this)?.()
          storeReleases.delete(this)
          this._subscribed = false
        }
      }
    },
    async loadForExecution(executionId: string) {
      this.ensureSubscription()
      const epoch = this._stateEpoch
      const version = (this._loadVersions[executionId] ?? 0) + 1
      this._loadVersions[executionId] = version
      this.loadingByExecution[executionId] = true
      delete this.errorsByExecution[executionId]
      try {
        const jobs = await getDesktopApi().conversion.listForExecution({ executionId })
        if (epoch !== this._stateEpoch || version !== this._loadVersions[executionId]) return
        this.jobsByExecution[executionId] = mergeJobs(this.jobsForExecution(executionId), jobs)
      } catch (error) {
        if (epoch === this._stateEpoch && version === this._loadVersions[executionId]) {
          this.errorsByExecution[executionId] = displayError(error, '本地转换结果加载失败')
        }
      } finally {
        if (epoch === this._stateEpoch && version === this._loadVersions[executionId]) {
          this.loadingByExecution[executionId] = false
        }
      }
    },
    applyEvent(event: ConversionJobEvent) {
      const executionId = event.job.executionId
      this.jobsByExecution[executionId] = mergeJobs(this.jobsForExecution(executionId), [event.job])
    },
    async actOnArtifact(action: 'saveCopy' | 'reveal' | 'deleteArtifact', artifact: ConversionArtifactView) {
      if (artifact.status !== 'ready' || this.pendingArtifactIds[artifact.artifactId]) return
      this.pendingArtifactIds[artifact.artifactId] = true
      delete this.actionErrorsByArtifact[artifact.artifactId]
      try {
        await getDesktopApi().conversion[action]({ artifactId: artifact.artifactId })
      } catch (error) {
        this.actionErrorsByArtifact[artifact.artifactId] = displayError(error, '转换产物操作失败，请稍后重试')
      } finally {
        delete this.pendingArtifactIds[artifact.artifactId]
      }
    },
  },
})

if (import.meta.hot) import.meta.hot.accept(acceptHMRUpdate(useConversionStore, import.meta.hot))
