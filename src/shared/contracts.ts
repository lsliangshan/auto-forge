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

export type AppView = 'workbench' | 'automationTasks'

export type BrowserViewState = {
  url: string
  title: string
  canGoBack: boolean
  loading: boolean
}

export type AutoForgeBridge = {
  getOverview: () => Promise<PlatformOverview>
  browser: {
    openWindow: () => Promise<void>
    loadUrl: (url: string) => Promise<BrowserViewState>
    goBack: () => Promise<BrowserViewState>
    getState: () => Promise<BrowserViewState>
    onStateChanged: (callback: (state: BrowserViewState) => void) => BridgeUnsubscribe
  }
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
  browserOpenWindow: 'browser:open-window',
  browserLoadUrl: 'browser:load-url',
  browserGoBack: 'browser:go-back',
  browserGetState: 'browser:get-state',
  browserStateChanged: 'browser:state-changed',
  workflowGetSnapshot: 'workflow:get-snapshot',
  workflowStart: 'workflow:start',
  workflowPause: 'workflow:pause',
  workflowResume: 'workflow:resume',
  workflowReset: 'workflow:reset',
  workflowChanged: 'workflow:changed',
  pluginsList: 'plugins:list',
  pluginsValidateManifest: 'plugins:validate-manifest'
} as const
