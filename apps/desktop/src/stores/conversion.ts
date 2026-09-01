import { acceptHMRUpdate, defineStore } from 'pinia'
import type { ConversionArtifactView, ConversionJobEvent, ConversionJobView, DesktopAPI } from '@autoforge/shared'
import { displayError, getDesktopApi } from '../services/desktop-api'

interface ConversionHub { listeners: Set<(event: ConversionJobEvent) => void>; unsubscribe: () => void }
interface ConversionRuntime { hubs: WeakMap<DesktopAPI, ConversionHub>; release?: () => void; disposeWrapped?: true }
const runtimeKey = Symbol.for('autoforge.conversion-store.runtime')
function runtime(store: object): ConversionRuntime {
  const target = store as object & { [runtimeKey]?: ConversionRuntime }
  target[runtimeKey] ??= { hubs: new WeakMap() }
  return target[runtimeKey]
}

function acquireConversionEvents(store: object, api: DesktopAPI, listener: (event: ConversionJobEvent) => void): () => void {
  const state = runtime(store)
  const existing = state.hubs.get(api)
  const hub: ConversionHub = existing ?? { listeners: new Set(), unsubscribe: () => undefined }
  if (!existing) {
    hub.unsubscribe = api.conversion.onEvent((event) => { for (const current of hub.listeners) current(event) })
    state.hubs.set(api, hub)
  }
  hub.listeners.add(listener)
  let active = true
  return () => {
    if (!active) return
    active = false
    hub.listeners.delete(listener)
    if (!hub.listeners.size) {
      hub.unsubscribe()
      state.hubs.delete(api)
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

function canActOnJob(action: 'cancel' | 'retry', status: ConversionJobView['status']): boolean {
  return action === 'cancel'
    ? ['queued', 'downloading_component', 'converting', 'verifying'].includes(status)
    : ['failed', 'cancelled', 'interrupted'].includes(status)
}

function mergeArtifacts(current: ConversionJobView['artifacts'], candidate: ConversionJobView['artifacts']) {
  const artifacts = new Map(current.map((artifact) => [artifact.artifactId, artifact]))
  for (const artifact of candidate) {
    const previous = artifacts.get(artifact.artifactId)
    if (!previous) {
      artifacts.set(artifact.artifactId, artifact)
      continue
    }
    const metadata = previous.metadata || artifact.metadata
      ? {
        ...artifact.metadata,
        ...previous.metadata,
        ...(previous.metadata?.iconRepresentations || artifact.metadata?.iconRepresentations ? {
          iconRepresentations: [...new Set([
            ...(previous.metadata?.iconRepresentations ?? []),
            ...(artifact.metadata?.iconRepresentations ?? []),
          ])].sort((left, right) => left - right),
        } : {}),
      }
      : undefined
    artifacts.set(artifact.artifactId, {
      ...previous,
      status: previous.status === 'deleted' || artifact.status === 'deleted' ? 'deleted' : 'ready',
      ...(metadata === undefined ? {} : { metadata }),
    })
  }
  return [...artifacts.values()]
}
function newerJob(current: ConversionJobView | undefined, candidate: ConversionJobView): ConversionJobView {
  if (!current || candidate.epoch > current.epoch) return candidate
  if (candidate.epoch < current.epoch) return current
  const artifacts = mergeArtifacts(current.artifacts, candidate.artifacts)
  const currentRank = statusRank(current.status)
  const candidateRank = statusRank(candidate.status)
  const status = candidateRank > currentRank
    ? candidate.status
    : candidateRank < currentRank || (isTerminal(current.status) && current.status !== candidate.status)
      ? current.status
      : candidate.status
  return {
    ...current,
    status,
    progress: Math.max(current.progress, candidate.progress),
    artifacts,
    ...(status === candidate.status && candidate.errorCode !== undefined ? { errorCode: candidate.errorCode } : {}),
  }
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
    unavailableByExecution: {} as Record<string, true>,
    pendingJobIds: {} as Record<string, true>,
    actionErrorsByJob: {} as Record<string, string>,
    pendingArtifactIds: {} as Record<string, true>,
    actionErrorsByArtifact: {} as Record<string, string>,
    _loadVersions: {} as Record<string, number>,
    _observations: {} as Record<string, number>,
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
      runtime(this).release?.()
      runtime(this).release = undefined
      this._subscribed = false
      this._subscriptionUsers = 0
      this.jobsByExecution = {}
      this.loadingByExecution = {}
      this.errorsByExecution = {}
      this.unavailableByExecution = {}
      this.pendingJobIds = {}
      this.actionErrorsByJob = {}
      this.pendingArtifactIds = {}
      this.actionErrorsByArtifact = {}
      this._loadVersions = {}
      this._observations = {}
    },
    ensureSubscription() {
      if (this._subscribed && runtime(this).release) return
      runtime(this).release?.()
      this._subscribed = true
      runtime(this).release = acquireConversionEvents(this, getDesktopApi(), (event) => this.applyEvent(event))
      if (!runtime(this).disposeWrapped) {
        runtime(this).disposeWrapped = true
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
          runtime(this).release?.()
          runtime(this).release = undefined
          this._subscribed = false
        }
      }
    },
    async loadForExecution(executionId: string) {
      this.ensureSubscription()
      const epoch = this._stateEpoch
      const version = (this._loadVersions[executionId] ?? 0) + 1
      const observation = this._observations[executionId] ?? 0
      this._loadVersions[executionId] = version
      this.loadingByExecution[executionId] = true
      delete this.errorsByExecution[executionId]
      delete this.unavailableByExecution[executionId]
      try {
        const response = await getDesktopApi().conversion.listForExecution({ executionId })
        if (epoch !== this._stateEpoch || version !== this._loadVersions[executionId]
          || observation !== (this._observations[executionId] ?? 0)) return
        if (response.availability === 'unavailable') {
          this.jobsByExecution[executionId] = []
          this.unavailableByExecution[executionId] = true
        }
        else this.jobsByExecution[executionId] = mergeJobs(this.jobsForExecution(executionId), response.jobs)
      } catch (error) {
        if (epoch === this._stateEpoch && version === this._loadVersions[executionId]
          && observation === (this._observations[executionId] ?? 0)) {
          this.errorsByExecution[executionId] = displayError(error, '本地转换结果加载失败')
        }
      } finally {
        if (epoch === this._stateEpoch && version === this._loadVersions[executionId]
          && observation === (this._observations[executionId] ?? 0)) {
          this.loadingByExecution[executionId] = false
        }
      }
    },
    applyEvent(event: ConversionJobEvent) {
      const executionId = event.job.executionId
      this._observations[executionId] = (this._observations[executionId] ?? 0) + 1
      this.loadingByExecution[executionId] = false
      delete this.errorsByExecution[executionId]
      delete this.unavailableByExecution[executionId]
      this.jobsByExecution[executionId] = mergeJobs(this.jobsForExecution(executionId), [event.job])
    },
    async actOnJob(action: 'cancel' | 'retry', job: ConversionJobView) {
      if (!canActOnJob(action, job.status) || this.pendingJobIds[job.jobId]) return
      this.pendingJobIds[job.jobId] = true
      delete this.actionErrorsByJob[job.jobId]
      try {
        await getDesktopApi().conversion[action]({ jobId: job.jobId })
      } catch (error) {
        this.actionErrorsByJob[job.jobId] = displayError(error, '转换任务操作失败，请稍后重试')
      } finally {
        delete this.pendingJobIds[job.jobId]
      }
    },
    async actOnArtifact(action: 'saveCopy' | 'preview' | 'reveal' | 'deleteArtifact', artifact: ConversionArtifactView) {
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
