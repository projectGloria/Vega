import { BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { log } from './log'

const PRELOAD = join(__dirname, '../preload/index.js')

/**
 * Security posture shared by every window: the renderer gets no Node, no
 * remote module, and no direct filesystem access. Everything privileged goes
 * through the typed IPC surface in ipc.ts.
 */
const SECURE_WEB_PREFERENCES = {
  preload: PRELOAD,
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: false,
  webSecurity: true
} as const

function rendererUrl(page: 'index' | 'splash'): { url?: string; file?: string } {
  const devServer = process.env['ELECTRON_RENDERER_URL']
  if (is_dev() && devServer) {
    return { url: devServer + '/' + page + '.html' }
  }
  return { file: join(__dirname, '../renderer/' + page + '.html') }
}

function is_dev(): boolean {
  return !!process.env['ELECTRON_RENDERER_URL']
}

function load(window: BrowserWindow, page: 'index' | 'splash'): void {
  const target = rendererUrl(page)

  // A renderer that fails to load never fires ready-to-show, which would look
  // like a hang with no cause. Surface it instead.
  window.webContents.on('did-fail-load', (_e, code, description, url) => {
    log.error('renderer failed to load', page, code, description, url)
  })
  window.webContents.on('render-process-gone', (_e, details) => {
    log.error('renderer process gone', page, details.reason)
  })

  log.info('loading', page, target.url ?? target.file)

  const promise = target.url ? window.loadURL(target.url) : window.loadFile(target.file!)
  promise.catch((err: Error) => log.error('load failed for', page, err))
}

export function createSplashWindow(): BrowserWindow {
  const splash = new BrowserWindow({
    width: 460,
    height: 340,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: false,
    show: false,
    center: true,
    backgroundColor: '#00000000',
    title: 'Starting…',
    webPreferences: SECURE_WEB_PREFERENCES
  })

  splash.once('ready-to-show', () => splash.show())
  load(splash, 'splash')
  return splash
}

export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1120,
    height: 800,
    minWidth: 880,
    minHeight: 620,
    frame: false,
    show: false,
    backgroundColor: '#0b0e15',
    title: 'Vega',
    webPreferences: SECURE_WEB_PREFERENCES
  })

  // Anything trying to open a new window becomes an external browser tab
  // instead of an uncontrolled Electron window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  // Block in-page navigation away from the app shell.
  window.webContents.on('will-navigate', (event, url) => {
    const current = window.webContents.getURL()
    if (url !== current) {
      event.preventDefault()
      if (url.startsWith('https://') || url.startsWith('http://')) {
        void shell.openExternal(url)
      }
    }
  })

  const notifyMaximize = () => {
    window.webContents.send('window:maximize-changed', window.isMaximized())
  }
  window.on('maximize', notifyMaximize)
  window.on('unmaximize', notifyMaximize)

  load(window, 'index')
  return window
}
