import { defineStore } from 'pinia'
import type { WorkflowDetail, WorkflowQuery, WorkflowSummary } from '@autoforge/shared'
import { displayError, getDesktopApi } from '../services/desktop-api'

export const useWorkflowStore = defineStore('workflow', {
  state: () => ({
    items: [] as WorkflowSummary[], details: {} as Record<string, WorkflowDetail>, selectedKey: '',
    query: {} as WorkflowQuery, loading: false, detailLoading: false, importing: false, error: '',
    _loadVersion: 0, _detailVersion: 0,
  }),
  getters: {
    selectedDetail(state): WorkflowDetail | undefined { return state.details[state.selectedKey] },
  },
  actions: {
    async load(query?: WorkflowQuery) {
      this.query = { ...(query ?? this.query) }
      const version = ++this._loadVersion
      this.loading = true
      this.error = ''
      try {
        const items = await getDesktopApi().workflows.list(this.query)
        if (version === this._loadVersion) this.items = items
      } catch (error) { if (version === this._loadVersion) this.error = displayError(error, '工作流加载失败') }
      finally { if (version === this._loadVersion) this.loading = false }
    },
    async select(item: WorkflowSummary) {
      const key = `${item.id}@${item.version}`
      this.selectedKey = key
      const version = ++this._detailVersion
      this.detailLoading = true
      try {
        const detail = await getDesktopApi().workflows.get(item.id, item.version)
        if (version === this._detailVersion && this.selectedKey === key) this.details[key] = detail
      } catch (error) { if (version === this._detailVersion) this.error = displayError(error, '工作流详情加载失败') }
      finally { if (version === this._detailVersion) this.detailLoading = false }
    },
    async setEnabled(item: WorkflowSummary, enabled: boolean) {
      if (item.integrity === 'failed') return
      this.error = ''
      try {
        await getDesktopApi().workflows.setEnabled(item.id, enabled)
        this._loadVersion += 1
        this.loading = false
        const current = this.items.find(({ id }) => id === item.id)
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
        if (this.selectedKey === key) this.selectedKey = ''
      } catch (error) { this.error = displayError(error, '移除工作流失败'); throw error }
    },
    async importProject() {
      this.importing = true
      this.error = ''
      try {
        const project = await getDesktopApi().developer.registerProject()
        if (!project) return
        await getDesktopApi().workflows.installProject(project.id)
        await this.load()
      } catch (error) { this.error = displayError(error, '导入工作流失败') }
      finally { this.importing = false }
    },
  },
})
