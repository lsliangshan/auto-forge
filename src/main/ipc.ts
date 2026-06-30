import { BrowserWindow, app, ipcMain } from 'electron'
import { ipcChannels, type PlatformOverview } from '@shared/contracts'
import type { BrowserWindowManager } from './browser/browser-window-manager'
import type { PluginRegistry } from './plugins/plugin-registry'
import type { WorkflowRunner } from './workflow/workflow-runner'

type IpcDeps = {
  browserWindowManager: BrowserWindowManager
  workflowRunner: WorkflowRunner
  pluginRegistry: PluginRegistry
}

export function registerIpcHandlers({ browserWindowManager, workflowRunner, pluginRegistry }: IpcDeps): void {
  workflowRunner.on('changed', (snapshot) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(ipcChannels.workflowChanged, snapshot)
    }
  })

  ipcMain.handle(ipcChannels.getOverview, (): PlatformOverview => {
    return {
      app: {
        name: app.getName(),
        version: app.getVersion(),
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node
      },
      security: [
        {
          title: '上下文隔离',
          detail: 'Renderer 与 preload/Electron 内部逻辑运行在隔离上下文。',
          enabled: true
        },
        {
          title: '禁用 Node 集成',
          detail: '网页与第三方工具默认拿不到 require、fs、electron。',
          enabled: true
        },
        {
          title: '受控 IPC 网关',
          detail: 'Renderer 只能调用 preload 暴露的白名单能力。',
          enabled: true
        },
        {
          title: '插件权限声明',
          detail: 'Manifest 先声明能力，平台再决定是否执行。',
          enabled: true
        }
      ]
    }
  })

  ipcMain.handle(ipcChannels.browserOpenWindow, () => browserWindowManager.openWindow())
  ipcMain.handle(ipcChannels.browserLoadUrl, (event, url: string) => {
    return browserWindowManager.loadUrl(event, url)
  })
  ipcMain.handle(ipcChannels.browserGoBack, (event) => browserWindowManager.goBack(event))
  ipcMain.handle(ipcChannels.browserGetState, (event) => browserWindowManager.getState(event))
  ipcMain.handle(ipcChannels.workflowGetSnapshot, () => workflowRunner.getSnapshot())
  ipcMain.handle(ipcChannels.workflowStart, () => workflowRunner.start())
  ipcMain.handle(ipcChannels.workflowPause, () => workflowRunner.pause())
  ipcMain.handle(ipcChannels.workflowResume, () => workflowRunner.resume())
  ipcMain.handle(ipcChannels.workflowReset, () => workflowRunner.reset())
  ipcMain.handle(ipcChannels.pluginsList, () => pluginRegistry.list())
  ipcMain.handle(ipcChannels.pluginsValidateManifest, (_event, manifest: unknown) => {
    return pluginRegistry.validateManifest(manifest)
  })
}
