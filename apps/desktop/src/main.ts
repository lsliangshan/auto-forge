import { app, BrowserWindow } from 'electron'

function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
  })

  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (rendererUrl) {
    return window.loadURL(rendererUrl)
  }

  return window.loadFile(new URL('../renderer/index.html', import.meta.url).pathname)
}

app.whenReady().then(createWindow)
