import { BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import { resolve as resolvePath } from 'node:path'
import { access, constants as fsConstants, statfs } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import type { DownloadRequest, HistoryEntry, Settings } from '@shared/types'
import { getPaths } from './bootstrap/paths'
import { binaryVersions } from './bootstrap/index'
import { checkForYtdlpUpdate } from './ytdlp/updater'
import type { ClipboardInbox } from './clipboard-inbox'
import {
  clearHistory,
  createCategory,
  findCategory,
  getHistory,
  getSettings,
  removeCategory,
  removeHistoryEntry,
  updateSettings
} from './store'
import { probe, probeEntry, validateUrl, clearProbeCache } from './ytdlp/metadata'
import { asCookieBrowser, captureCookies, clearCookies, detectBrowsers } from './ytdlp/cookies'
import type { YtdlpContext } from './ytdlp/formats'
import type { QueueManager } from './queue/manager'

export function buildContext(): YtdlpContext {
  const paths = getPaths()
  const settings = getSettings()
  return {
    ytdlpExe: paths.ytdlpExe,
    ffmpegDir: paths.bin,
    cacheDir: paths.ytdlpCache,
    outputDir: settings.downloadDir,
    outputTemplate: settings.outputTemplate,
    // Checked on disk rather than trusted from settings: someone who deletes
    // cookies.txt by hand should get signed-out behaviour, not a broken flag.
    cookiesFile: settings.cookies && existsSync(paths.cookiesFile) ? paths.cookiesFile : null
  }
}

/** IPC payloads come from the renderer; never trust their shape. */
function asString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error('Invalid ' + field)
  return value
}

function sanitizeRequests(raw: unknown): DownloadRequest[] {
  if (!Array.isArray(raw)) throw new Error('Invalid download request')

  return raw.map((entry) => {
    const req = entry as Partial<DownloadRequest>
    const url = validateUrl(asString(req.url, 'url'))
    const selection = req.selection

    if (!selection || typeof selection !== 'object') throw new Error('Missing format selection')

    switch (selection.mode) {
      case 'best':
        break
      case 'quality':
        if (!Number.isFinite(selection.height)) throw new Error('Invalid quality')
        break
      case 'format':
        // Format ids reach the command line, so keep them to the character
        // class yt-dlp actually uses.
        if (!/^[\w.+-]{1,64}$/.test(String(selection.formatId))) {
          throw new Error('Invalid format id')
        }
        break
      case 'audio':
        if (!['mp3', 'm4a', 'flac', 'wav', 'opus'].includes(selection.codec)) {
          throw new Error('Invalid audio codec')
        }
        break
      default:
        throw new Error('Invalid format selection')
    }

    return {
      url,
      title: typeof req.title === 'string' ? req.title.slice(0, 300) : url,
      uploader: typeof req.uploader === 'string' ? req.uploader.slice(0, 200) : null,
      thumbnail: typeof req.thumbnail === 'string' ? req.thumbnail : null,
      duration: typeof req.duration === 'number' ? req.duration : null,
      selection,
      // An id that does not match a real category becomes null rather than
      // being trusted into a path segment.
      categoryId: findCategory(req.categoryId)?.id ?? null,
      outputDir: typeof req.outputDir === 'string' ? resolvePath(req.outputDir) : undefined,
      subtitleLangs: Array.isArray(req.subtitleLangs)
        ? req.subtitleLangs.filter((l): l is string => typeof l === 'string').slice(0, 20)
        : undefined,
      embedSubs: req.embedSubs === true,
      embedThumbnail: req.embedThumbnail === true,
      embedMetadata: req.embedMetadata === true,
      sponsorblock: req.sponsorblock === true
    }
  })
}

export interface IpcDeps {
  queue: QueueManager
  inbox: ClipboardInbox
  getMainWindow: () => BrowserWindow | null
  onBootstrapRetry: () => void
  onBootstrapContinue: () => void
  onHistoryChanged: (entries: HistoryEntry[]) => void
}

export function registerIpc(deps: IpcDeps): void {
  /* ---- window chrome ---- */
  ipcMain.on('window:minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })

  ipcMain.on('window:toggle-maximize', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
  })

  ipcMain.on('window:close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })

  /* ---- bootstrap ---- */
  ipcMain.on('bootstrap:retry', () => deps.onBootstrapRetry())
  ipcMain.on('bootstrap:continue', () => deps.onBootstrapContinue())

  /* ---- media ---- */
  ipcMain.handle('media:probe', async (_event, url: unknown) => {
    return probe(asString(url, 'url'), buildContext())
  })

  ipcMain.handle('media:probe-entry', async (_event, url: unknown) => {
    return probeEntry(asString(url, 'url'), buildContext())
  })

  /* ---- queue ---- */
  ipcMain.handle('queue:add', async (_event, requests: unknown) =>
    deps.queue.add(sanitizeRequests(requests))
  )
  ipcMain.handle('queue:pause', async (_event, id: unknown) => deps.queue.pause(asString(id, 'id')))
  ipcMain.handle('queue:resume', async (_event, id: unknown) =>
    deps.queue.resume(asString(id, 'id'))
  )
  ipcMain.handle('queue:cancel', async (_event, id: unknown) =>
    deps.queue.cancel(asString(id, 'id'))
  )
  ipcMain.handle('queue:retry', async (_event, id: unknown) => deps.queue.retry(asString(id, 'id')))
  ipcMain.handle('queue:remove', async (_event, id: unknown) =>
    deps.queue.remove(asString(id, 'id'))
  )
  ipcMain.handle('queue:clear-finished', async () => deps.queue.clearFinished())
  ipcMain.handle('queue:list', async () => deps.queue.list())
  ipcMain.handle('queue:log', async (_event, id: unknown) => deps.queue.getLog(asString(id, 'id')))

  /* ---- settings ---- */
  ipcMain.handle('settings:get', async () => getSettings())

  ipcMain.handle('settings:set', async (_event, patch: unknown) => {
    const incoming = (patch ?? {}) as Partial<Settings>
    const next = await updateSettings(incoming)
    // Only the keys that actually change what a probe returns invalidate it.
    // Throwing away freshly fetched metadata because someone moved the accent
    // slider means the next paste has to go back to the network for nothing.
    const affectsProbe: (keyof Settings)[] = ['downloadDir', 'outputTemplate', 'cookies']
    if (affectsProbe.some((key) => key in incoming)) clearProbeCache()
    return next
  })

  ipcMain.handle('settings:pick-dir', async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const result = window
      ? await dialog.showOpenDialog(window, {
          properties: ['openDirectory', 'createDirectory'],
          defaultPath: getSettings().downloadDir
        })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })

    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('settings:versions', async () => ({ ...binaryVersions }))

  // force: the user pressed the button, so ignore both the interval and the
  // auto-update preference.
  ipcMain.handle('settings:update-ytdlp', async () => checkForYtdlpUpdate(true))

  /* ---- clipboard inbox ---- */
  ipcMain.handle('inbox:list', async () => deps.inbox.list())
  ipcMain.handle('inbox:remove', async (_e, id: unknown) => deps.inbox.remove(asString(id, 'id')))
  ipcMain.handle('inbox:clear', async () => deps.inbox.clear())
  ipcMain.handle('inbox:retry', async (_e, id: unknown) => deps.inbox.retry(asString(id, 'id')))

  /* ---- history ---- */
  ipcMain.handle('history:list', async () => getHistory())
  ipcMain.handle('history:remove', async (_e, id: unknown) => {
    const next = await removeHistoryEntry(asString(id, 'id'))
    deps.onHistoryChanged(next)
  })
  ipcMain.handle('history:clear', async () => {
    const next = await clearHistory()
    deps.onHistoryChanged(next)
  })
  ipcMain.handle('history:file-exists', async (_e, path: unknown) => {
    if (typeof path !== 'string' || !path) return false
    return access(resolvePath(path), fsConstants.F_OK).then(
      () => true,
      () => false
    )
  })

  /* ---- categories ---- */
  ipcMain.handle('categories:create', async (_e, name: unknown) =>
    createCategory(asString(name, 'name'))
  )
  ipcMain.handle('categories:remove', async (_e, id: unknown) =>
    removeCategory(asString(id, 'id'))
  )

  /* ---- cookies ---- */
  ipcMain.handle('cookies:browsers', async () => detectBrowsers())

  ipcMain.handle('cookies:capture', async (_e, browser: unknown) => {
    const status = await captureCookies(asCookieBrowser(browser))
    // A fresh jar invalidates cached probes: the same URL can resolve
    // differently once yt-dlp is signed in.
    clearProbeCache()
    return updateSettings({ cookies: status })
  })

  ipcMain.handle('cookies:clear', async () => {
    await clearCookies()
    clearProbeCache()
    return updateSettings({ cookies: null })
  })

  /* ---- system ---- */
  // The sidebar shows headroom on the volume downloads land on, so the answer
  // has to follow the configured folder rather than the app's own drive.
  ipcMain.handle('system:disk-space', async () => {
    try {
      const stats = await statfs(getSettings().downloadDir)
      const total = stats.blocks * stats.bsize
      const free = stats.bavail * stats.bsize
      return Number.isFinite(total) && total > 0 ? { free, total } : null
    } catch {
      // An unplugged or unreadable drive is not worth an error dialog.
      return null
    }
  })

  ipcMain.handle('system:clipboard', async () => clipboard.readText())

  ipcMain.handle('system:write-clipboard', async (_e, text: unknown) => {
    clipboard.writeText(asString(text, 'text').slice(0, 4096))
  })

  ipcMain.handle('system:open-path', async (_event, path: unknown) => {
    await shell.openPath(resolvePath(asString(path, 'path')))
  })

  ipcMain.handle('system:show-in-folder', async (_event, path: unknown) => {
    shell.showItemInFolder(resolvePath(asString(path, 'path')))
  })

  ipcMain.handle('system:open-external', async (_event, url: unknown) => {
    // Guards against file:// or custom-scheme URLs reaching the OS handler.
    await shell.openExternal(validateUrl(asString(url, 'url')))
  })
}
