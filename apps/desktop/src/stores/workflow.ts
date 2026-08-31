import { defineStore } from 'pinia'
import type { ExecutionSummary, WorkflowDetail, WorkflowQuery, WorkflowSummary } from '@autoforge/shared'
import { displayError, getDesktopApi } from '../services/desktop-api'

export const useWorkflowStore = defineStore('workflow', {
  state: () => ({
    items: [] as WorkflowSummary[], details: {} as Record<string, WorkflowDetail>,
    recentExecutions: {} as Record<string, ExecutionSummary[]>, selectedKey: '',
    query: {} as WorkflowQuery, loading: false, detailLoading: false, importing: false,
    importStage: '' as '' | 'registering' | 'building' | 'validating' | 'installing', error: '',
    _loadVersion: 0, _detailVersion: 0,
  }),
  getters: {
    selectedDetail(state): WorkflowDetail | undefined { return state.details[state.selectedKey] },
  },
  actions: {
    async load(query?: WorkflowQuery) {
      const requestQuery = { ...(query ?? this.query) }
      this.query = requestQuery
      const version = ++this._loadVersion
      this.loading = true
      this.error = ''
      try {
        const api = getDesktopApi()
        let legacyCity: string | undefined
        let items: WorkflowSummary[]
        try {
          items = await api.workflows.list(requestQuery)
        } catch (error) {
          if (!requestQuery.city || typeof error !== 'object' || error === null
            || !('code' in error) || error.code !== 'INVALID_INPUT') throw error
          const { city, ...legacyQuery } = requestQuery
          legacyCity = city
          items = await api.workflows.list(legacyQuery)
        }
        const needsCityHydration = items.some((item) => !Array.isArray(item.cities))
        const hydratedItems = needsCityHydration
          ? await Promise.all(items.map(async (item) => {
              if (Array.isArray(item.cities)) return item
              const detail = await api.workflows.get(item.id, item.version)
              return { ...item, cities: detail.cities }
            }))
          : items
        const visibleItems = legacyCity
          ? hydratedItems.filter((item) => !item.cities.length || item.cities.includes(legacyCity))
          : hydratedItems
        if (version === this._loadVersion) this.items = visibleItems
      } catch (error) { if (version === this._loadVersion) this.error = displayError(error, '工作流加载失败') }
      finally { if (version === this._loadVersion) this.loading = false }
    },
    async select(item: WorkflowSummary) {
      const key = `${item.id}@${item.version}`
      this.selectedKey = key
      const version = ++this._detailVersion
      this.detailLoading = true
      try {
        const [detail, executions] = await Promise.all([
          getDesktopApi().workflows.get(item.id, item.version),
          getDesktopApi().executions.list({ workflowId: item.id }),
        ])
        if (version === this._detailVersion && this.selectedKey === key) {
          this.details[key] = detail
          this.recentExecutions[key] = executions.filter(({ workflowVersion }) => workflowVersion === item.version).slice(0, 5)
        }
      } catch (error) { if (version === this._detailVersion) this.error = displayError(error, '工作流详情加载失败') }
      finally { if (version === this._detailVersion) this.detailLoading = false }
    },
    async setEnabled(item: WorkflowSummary, enabled: boolean) {
      if (item.integrity === 'failed') return
      this.error = ''
      try {
        await getDesktopApi().workflows.setEnabled(item.id, item.version, enabled)
        this._loadVersion += 1
        this.loading = false
        const current = this.items.find(({ id, version }) => id === item.id && version === item.version)
        if (current) current.enabled = enabled
      } catch (error) { this.error = displayError(error, '工作流状态更新失败') }
    },
    async remove(item: WorkflowSummary) {
      if (item.source !== 'installed') return
      this.error = ''
      try {
        await getDesktopApi().workflows.remove(item.id, item.version)
        this._loadVersion += 1
        this.loading = false
        this.items = this.items.filter(({ id, version }) => id !== item.id || version !== item.version)
        const key = `${item.id}@${item.version}`
        delete this.details[key]
        delete this.recentExecutions[key]
        if (this.selectedKey === key) this.selectedKey = ''
      } catch (error) { this.error = displayError(error, '移除工作流失败'); throw error }
    },
    async importProject() {
      this.importing = true
      this.error = ''
      try {
        this.importStage = 'registering'
        const project = await getDesktopApi().developer.registerProject()
        if (!project) return
        this.importStage = 'building'
        await getDesktopApi().developer.build(project.id)
        this.importStage = 'validating'
        const validation = await getDesktopApi().developer.validate(project.id)
        if (!validation.valid) {
          this.error = validation.diagnostics.map(({ message }) => message).join('；') || '工作流校验失败'
          return
        }
        this.importStage = 'installing'
        await getDesktopApi().workflows.installProject(project.id)
        await this.load()
      } catch (error) { this.error = displayError(error, '导入工作流失败') }
      finally { this.importing = false; this.importStage = '' }
    },
  },
})
