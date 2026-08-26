import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  BootstrapState,
  BrowserPresence,
  ClipboardEntry,
  HistoryEntry,
  DownloadRequest,
  ProbeResult,
  QueueItem,
  RendererApi,
  Settings,
  VideoInfo,
  BinaryVersions,
  DiskSpace
} from '@shared/types'

/**
 * Subscribes to a main-process channel and returns an unsubscribe function, so
 * React effects can clean up without leaking listeners across remounts.
 */
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: RendererApi = {
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
    close: () => ipcRenderer.send('window:close'),
    onMaximizeChange: (cb) => subscribe<boolean>('window:maximize-changed', cb)
  },

  bootstrap: {
    onProgress: (cb) => subscribe<BootstrapState>('bootstrap:progress', cb),
    retry: () => ipcRenderer.send('bootstrap:retry'),
    continueAnyway: () => ipcRenderer.send('bootstrap:continue')
  },

  media: {
    probe: (url: string): Promise<ProbeResult> => ipcRenderer.invoke('media:probe', url),
    probeEntry: (url: string): Promise<VideoInfo> => ipcRenderer.invoke('media:probe-entry', url)
  },

  queue: {
    add: (requests: DownloadRequest[]): Promise<string[]> =>
      ipcRenderer.invoke('queue:add', requests),
    pause: (id) => ipcRenderer.invoke('queue:pause', id),
    resume: (id) => ipcRenderer.invoke('queue:resume', id),
    cancel: (id) => ipcRenderer.invoke('queue:cancel', id),
    retry: (id) => ipcRenderer.invoke('queue:retry', id),
    remove: (id) => ipcRenderer.invoke('queue:remove', id),
    clearFinished: () => ipcRenderer.invoke('queue:clear-finished'),
    list: (): Promise<QueueItem[]> => ipcRenderer.invoke('queue:list'),
    onUpdate: (cb) => subscribe<QueueItem[]>('queue:items', cb),
    onItemProgress: (cb) => subscribe<QueueItem>('queue:progress', cb),
    getLog: (id): Promise<string[]> => ipcRenderer.invoke('queue:log', id)
  },

  settings: {
    get: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
    set: (patch): Promise<Settings> => ipcRenderer.invoke('settings:set', patch),
    pickDownloadDir: (): Promise<string | null> => ipcRenderer.invoke('settings:pick-dir'),
    versions: (): Promise<BinaryVersions> => ipcRenderer.invoke('settings:versions'),
    updateYtdlp: () => ipcRenderer.invoke('settings:update-ytdlp')
  },

  clipboardInbox: {
    list: (): Promise<ClipboardEntry[]> => ipcRenderer.invoke('inbox:list'),
    remove: (id) => ipcRenderer.invoke('inbox:remove', id),
    clear: () => ipcRenderer.invoke('inbox:clear'),
    retry: (id) => ipcRenderer.invoke('inbox:retry', id),
    onUpdate: (cb) => subscribe<ClipboardEntry[]>('inbox:items', cb)
  },

  history: {
    list: (): Promise<HistoryEntry[]> => ipcRenderer.invoke('history:list'),
    remove: (id) => ipcRenderer.invoke('history:remove', id),
    clear: () => ipcRenderer.invoke('history:clear'),
    onUpdate: (cb) => subscribe<HistoryEntry[]>('history:items', cb),
    fileExists: (path): Promise<boolean> => ipcRenderer.invoke('history:file-exists', path)
  },

  categories: {
    create: (name): Promise<Settings> => ipcRenderer.invoke('categories:create', name),
    remove: (id): Promise<Settings> => ipcRenderer.invoke('categories:remove', id)
  },

  cookies: {
    browsers: (): Promise<BrowserPresence[]> => ipcRenderer.invoke('cookies:browsers'),
    capture: (browser): Promise<Settings> => ipcRenderer.invoke('cookies:capture', browser),
    clear: (): Promise<Settings> => ipcRenderer.invoke('cookies:clear')
  },

  system: {
    diskSpace: (): Promise<DiskSpace | null> => ipcRenderer.invoke('system:disk-space'),
    readClipboard: (): Promise<string> => ipcRenderer.invoke('system:clipboard'),
    writeClipboard: (text) => ipcRenderer.invoke('system:write-clipboard', text),
    openPath: (path) => ipcRenderer.invoke('system:open-path', path),
    showInFolder: (path) => ipcRenderer.invoke('system:show-in-folder', path),
    openExternal: (url) => ipcRenderer.invoke('system:open-external', url)
  }
}

contextBridge.exposeInMainWorld('api', api)
