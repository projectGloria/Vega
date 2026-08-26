import { app, BrowserWindow } from 'electron'
import type { BootstrapState, QueueItem } from '@shared/types'
import { Bootstrapper } from './bootstrap/index'
import { createMainWindow, createSplashWindow } from './windows'
import { buildContext, registerIpc } from './ipc'
import { QueueManager } from './queue/manager'
import {
  addHistoryEntry,
  findCategory,
  getHistory,
  getSettings,
  loadHistory,
  loadQueue,
  saveQueue
} from './store'
import { log } from './log'
import { scheduleYtdlpUpdateCheck } from './ytdlp/updater'
import { TrayController } from './tray'
import { ClipboardWatcher } from './clipboard-watch'
import { ClipboardInbox, sameVideo } from './clipboard-inbox'

// An unhandled rejection during startup would otherwise leave the splash
// spinning with no explanation anywhere.
process.on('unhandledRejection', (reason) => log.error('unhandledRejection', reason))
process.on('uncaughtException', (err) => log.error('uncaughtException', err))

app.setName('VideoDownloader')

/** Even a fast bootstrap should not flash the splash for two frames. */
const MIN_SPLASH_MS = 700

let splashWindow: BrowserWindow | null = null
let mainWindow: BrowserWindow | null = null
let bootstrapper: Bootstrapper | null = null
let queue: QueueManager | null = null
let startedAt = 0
let handedOff = false
let updateTimer: NodeJS.Timeout | null = null
let tray: TrayController | null = null
let clipboardWatcher: ClipboardWatcher | null = null
let inbox: ClipboardInbox | null = null
/** Distinguishes a real quit from a window close that should hide to the tray. */
let quitting = false

function sendToSplash(state: BootstrapState): void {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents.send('bootstrap:progress', state)
  }
}

function sendQueueItems(items: QueueItem[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('queue:items', items)
  }
  // The tray tooltip and taskbar bar read from the same snapshot as the UI.
  tray?.update(items)
}

/** Brings the window back from minimized/background, e.g. from the tray. */
function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function sendQueueProgress(item: QueueItem): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('queue:progress', item)
  }
}

/** Swaps the splash for the main window once everything is verified. */
async function handOffToMainWindow(): Promise<void> {
  if (handedOff) return
  handedOff = true

  const elapsed = Date.now() - startedAt
  if (elapsed < MIN_SPLASH_MS) {
    await new Promise((r) => setTimeout(r, MIN_SPLASH_MS - elapsed))
  }

  const stored = await loadQueue().catch(() => [] as QueueItem[])
  log.info('bootstrap complete, opening main window; restored', stored.length, 'queue items')

  mainWindow = createMainWindow()
  mainWindow.once('ready-to-show', () => {
    log.info('main window ready')
    mainWindow?.show()
    mainWindow?.focus()
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.destroy()
      splashWindow = null
    }
  })

  // Closing hides to the tray unless the user is really quitting, so the
  // background clipboard capture survives closing the window.
  mainWindow.on('close', (event) => {
    if (!quitting && getSettings().closeToTray) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // The renderer subscribes on mount, so hydrate after the window exists.
  mainWindow.webContents.once('did-finish-load', () => {
    if (stored.length > 0) queue?.hydrate(stored)
  })

  // Guarded: a retry after a failed bootstrap clears `handedOff`, and creating
  // a second tray would leave two icons in the notification area.
  if (!tray) {
    tray = new TrayController(() => mainWindow, {
      pauseAll: () => queue?.pauseAll(),
      resumeAll: () => queue?.resumeAll(),
      showWindow: showMainWindow
    })
    tray.create()
  }

  clipboardWatcher ??= new ClipboardWatcher((url) => {
    log.info('clipboard link detected:', url)
    // Captured into the inbox whether or not a window is open — that is what
    // makes the "From clipboard" list useful after working in the background.
    // The inbox is the only place it surfaces; echoing it into the download
    // view as well just showed the same link twice.
    inbox?.add(url)
  })
  clipboardWatcher.start()

  updateTimer = scheduleYtdlpUpdateCheck()
}

async function runBootstrap(): Promise<void> {
  if (!bootstrapper) return
  log.info('bootstrap starting')
  const state = await bootstrapper.run()
  log.info(
    'bootstrap finished; done=' + state.done,
    state.error ? 'error at ' + state.error.step + ': ' + state.error.message : ''
  )
  if (state.done) void handOffToMainWindow()
}

function sendToWindow(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

function createQueue(): QueueManager {
  return new QueueManager(
    () => buildContext(),
    () => getSettings().concurrency,
    () => {
      const s = getSettings()
      return {
        subtitleLangs: s.subtitleLangs,
        embedSubs: s.embedSubs,
        embedThumbnail: s.embedThumbnail,
        embedMetadata: s.embedMetadata,
        sponsorblock: s.sponsorblock
      }
    },
    { onItems: sendQueueItems, onProgress: sendQueueProgress },
    (id) => findCategory(id),
    async (entry) => {
      const entries = await addHistoryEntry(entry)
      sendToWindow('history:items', entries)
    }
  )
}

// A second launch should focus the running app, not start a rival copy that
// fights over the same binaries and queue file.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const target = mainWindow ?? splashWindow
    if (target && !target.isDestroyed()) {
      if (target.isMinimized()) target.restore()
      target.focus()
    }
  })

  app.whenReady().then(async () => {
    startedAt = Date.now()
    queue = createQueue()

    inbox = new ClipboardInbox(
      () => buildContext(),
      (entries) => sendToWindow('inbox:items', entries),
      // A link already queued, downloading, or downloaded is not new.
      (url) =>
        (queue?.list() ?? []).some((item) => sameVideo(item.url, url)) ||
        getHistory().some((entry) => sameVideo(entry.url, url))
    )
    await inbox.load().catch(() => {})
    await loadHistory().catch(() => {})

    registerIpc({
      queue,
      inbox,
      onHistoryChanged: (entries) => sendToWindow('history:items', entries),
      getMainWindow: () => mainWindow,
      onBootstrapRetry: () => {
        handedOff = false
        void runBootstrap()
      },
      onBootstrapContinue: () => {
        bootstrapper?.forceComplete()
        void handOffToMainWindow()
      }
    })

    splashWindow = createSplashWindow()
    bootstrapper = new Bootstrapper(sendToSplash)

    // Wait for the splash to mount so it does not miss the first progress events.
    splashWindow.webContents.once('did-finish-load', () => {
      void runBootstrap()
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0 && handedOff) {
        void handOffToMainWindow()
      }
    })
  })

  // With closeToTray on, closing the window hides it instead of quitting, so
  // clipboard capture keeps running. Quit is then an explicit act: the tray
  // menu, or the setting turned off.
  app.on('window-all-closed', () => {
    if (getSettings().closeToTray && !quitting) return
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    quitting = true
  })

  // Downloads spawn ffmpeg children; without this they outlive the app.
  app.on('before-quit', () => {
    bootstrapper?.cancel()
    if (updateTimer) clearTimeout(updateTimer)
    clipboardWatcher?.stop()
    tray?.destroy()
    if (queue) {
      const items = queue.list()
      queue.shutdown()
      saveQueue(items).catch(() => {})
    }
  })
}
