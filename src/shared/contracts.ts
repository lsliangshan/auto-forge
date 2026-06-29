import type { PluginValidationResult, ToolManifest } from './plugin'
import type { WorkflowSnapshot } from './workflow'

export type AppInfo = {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
}

export type SecurityCapability = {
  title: string
  detail: string
  enabled: boolean
}

export type PlatformOverview = {
  app: AppInfo
  security: SecurityCapability[]
}

export type BridgeUnsubscribe = () => void

export type AutoForgeBridge = {
  getOverview: () => Promise<PlatformOverview>
  workflow: {
    getSnapshot: () => Promise<WorkflowSnapshot>
    start: () => Promise<WorkflowSnapshot>
    pause: () => Promise<WorkflowSnapshot>
    resume: () => Promise<WorkflowSnapshot>
    reset: () => Promise<WorkflowSnapshot>
    onChanged: (callback: (snapshot: WorkflowSnapshot) => void) => BridgeUnsubscribe
  }
  plugins: {
    list: () => Promise<ToolManifest[]>
    validateManifest: (manifest: unknown) => Promise<PluginValidationResult>
  }
}

export const ipcChannels = {
  getOverview: 'platform:get-overview',
  workflowGetSnapshot: 'workflow:get-snapshot',
  workflowStart: 'workflow:start',
  workflowPause: 'workflow:pause',
  workflowResume: 'workflow:resume',
  workflowReset: 'workflow:reset',
  workflowChanged: 'workflow:changed',
  pluginsList: 'plugins:list',
  pluginsValidateManifest: 'plugins:validate-manifest'
} as const
