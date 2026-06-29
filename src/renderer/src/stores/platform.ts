import { defineStore } from 'pinia'
import type { PlatformOverview } from '@shared/contracts'
import type { ToolManifest } from '@shared/plugin'
import type { WorkflowSnapshot } from '@shared/workflow'

type PlatformState = {
  overview: PlatformOverview | null
  workflow: WorkflowSnapshot | null
  plugins: ToolManifest[]
  loading: boolean
}

export const usePlatformStore = defineStore('platform', {
  state: (): PlatformState => ({
    overview: null,
    workflow: null,
    plugins: [],
    loading: true
  }),
  actions: {
    async bootstrap() {
      const [overview, workflow, plugins] = await Promise.all([
        window.autoForge.getOverview(),
        window.autoForge.workflow.getSnapshot(),
        window.autoForge.plugins.list()
      ])

      this.overview = overview
      this.workflow = workflow
      this.plugins = plugins
      this.loading = false
    },
    setWorkflow(snapshot: WorkflowSnapshot) {
      this.workflow = snapshot
    },
    async startWorkflow() {
      this.workflow = await window.autoForge.workflow.start()
    },
    async pauseWorkflow() {
      this.workflow = await window.autoForge.workflow.pause()
    },
    async resumeWorkflow() {
      this.workflow = await window.autoForge.workflow.resume()
    },
    async resetWorkflow() {
      this.workflow = await window.autoForge.workflow.reset()
    }
  }
})
