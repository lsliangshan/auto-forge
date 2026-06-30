import { BrowserWindow, WebContentsView, shell, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import { ipcChannels, type BrowserViewState } from '@shared/contracts'
import { normalizeBrowserUrl } from '@shared/browser-url'
import { createInlineWindowOpenHandler } from './window-open-handler'

const toolbarHeight = 56

type BrowserSession = {
  window: BrowserWindow
  view: WebContentsView
  title: string
  loading: boolean
}

export class BrowserWindowManager {
  private readonly sessions = new Map<number, BrowserSession>()

  openWindow(): void {
    const window = new BrowserWindow({
      width: 1120,
      height: 760,
      minWidth: 1040,
      minHeight: 680,
      show: false,
      title: 'AutoForge Browser',
      backgroundColor: '#f5f7fa',
      webPreferences: {
        preload: join(__dirname, '../preload/index.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true
      }
    })

    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true
      }
    })
    const session: BrowserSession = {
      window,
      view,
      title: '',
      loading: false
    }

    this.sessions.set(window.id, session)
    window.contentView.addChildView(view)
    this.layout(session)

    window.on('resize', () => this.layout(session))
    window.on('closed', () => {
      this.sessions.delete(window.id)
    })
    window.on('ready-to-show', () => {
      window.show()
    })

    window.webContents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url)
      return { action: 'deny' }
    })

    view.webContents.setWindowOpenHandler(
      createInlineWindowOpenHandler((url) => view.webContents.loadURL(url))
    )
    view.webContents.on('did-start-loading', () => {
      session.loading = true
      this.emitState(session)
    })
    view.webContents.on('did-stop-loading', () => {
      session.loading = false
      this.emitState(session)
    })
    view.webContents.on('did-navigate', () => {
      this.emitState(session)
    })
    view.webContents.on('did-navigate-in-page', () => {
      this.emitState(session)
    })
    view.webContents.on('page-title-updated', (_event, title) => {
      session.title = title
      window.setTitle(title ? `${title} - AutoForge Browser` : 'AutoForge Browser')
      this.emitState(session)
    })

    void view.webContents.loadURL('about:blank')
    void this.loadChrome(window)
  }

  async loadUrl(event: IpcMainInvokeEvent, input: string): Promise<BrowserViewState> {
    const session = this.requireSession(event)
    const url = normalizeBrowserUrl(input)
    await session.view.webContents.loadURL(url)
    return this.getStateForSession(session)
  }

  goBack(event: IpcMainInvokeEvent): BrowserViewState {
    const session = this.requireSession(event)
    if (session.view.webContents.navigationHistory.canGoBack()) {
      session.view.webContents.navigationHistory.goBack()
    }
    return this.getStateForSession(session)
  }

  getState(event: IpcMainInvokeEvent): BrowserViewState {
    return this.getStateForSession(this.requireSession(event))
  }

  private async loadChrome(window: BrowserWindow): Promise<void> {
    if (is.dev && process.env.ELECTRON_RENDERER_URL) {
      await window.loadURL(`${process.env.ELECTRON_RENDERER_URL}#/browser`)
      return
    }

    await window.loadFile(join(__dirname, '../renderer/index.html'), { hash: '/browser' })
  }

  private layout(session: BrowserSession): void {
    const bounds = session.window.getContentBounds()
    session.view.setBounds({
      x: 0,
      y: toolbarHeight,
      width: bounds.width,
      height: Math.max(0, bounds.height - toolbarHeight)
    })
  }

  private requireSession(event: IpcMainInvokeEvent): BrowserSession {
    const window = BrowserWindow.fromWebContents(event.sender)
    const session = window ? this.sessions.get(window.id) : undefined

    if (!session) {
      throw new Error('Browser window session was not found.')
    }

    return session
  }

  private getStateForSession(session: BrowserSession): BrowserViewState {
    const currentUrl = session.view.webContents.getURL()
    return {
      url: currentUrl === 'about:blank' ? '' : currentUrl,
      title: session.title,
      canGoBack: session.view.webContents.navigationHistory.canGoBack(),
      loading: session.loading
    }
  }

  private emitState(session: BrowserSession): void {
    if (session.window.isDestroyed()) {
      return
    }

    session.window.webContents.send(
      ipcChannels.browserStateChanged,
      this.getStateForSession(session)
    )
  }
}
