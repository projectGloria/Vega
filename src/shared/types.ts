/**
 * The contract between the main process and the renderer.
 * Everything crossing the contextBridge is described here.
 */

/* ------------------------------------------------------------------ */
/* Bootstrap / splash                                                  */
/* ------------------------------------------------------------------ */

export type BootstrapStepId =
  | 'appdata'
  | 'ytdlp'
  | 'ffmpeg'
  | 'probe'
  | 'cache'
  | 'settings'

export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export interface BootstrapStep {
  id: BootstrapStepId
  label: string
  status: StepStatus
  /** 0-100 while downloading, null when the work has no measurable progress */
  percent: number | null
  /** Short human line under the step, e.g. "18.2 MB / 84.0 MB" */
  detail: string | null
}

export interface BootstrapState {
  steps: BootstrapStep[]
  /** Overall 0-100 across all steps */
  overall: number
  done: boolean
  error: { step: BootstrapStepId; message: string; canContinue: boolean } | null
}

/* ------------------------------------------------------------------ */
/* Media metadata                                                      */
/* ------------------------------------------------------------------ */

export interface MediaFormat {
  formatId: string
  ext: string
  /** Video height in px; null for audio-only formats */
  height: number | null
  width: number | null
  fps: number | null
  vcodec: string | null
  acodec: string | null
  /** Bytes; exact when known, otherwise the estimate */
  filesize: number | null
  filesizeIsEstimate: boolean
  tbr: number | null
  /** Human label, e.g. "1080p60" or "opus 160k" */
  label: string
  kind: 'video' | 'audio' | 'combined'
}

export interface SubtitleTrack {
  lang: string
  name: string
  /** True when it is an auto-generated caption track */
  auto: boolean
}

export interface VideoInfo {
  id: string
  url: string
  title: string
  uploader: string | null
  duration: number | null
  thumbnail: string | null
  extractor: string | null
  isLive: boolean
  formats: MediaFormat[]
  subtitles: SubtitleTrack[]
  /** Quality heights offered as quick chips, descending */
  qualities: number[]
}

export interface PlaylistEntry {
  id: string
  url: string
  title: string
  /** Per-entry author: a channel's tabs and a mixed playlist have several. */
  uploader: string | null
  duration: number | null
  thumbnail: string | null
  /**
   * Which tab or sub-playlist the entry came from ("Videos", "Shorts", ...),
   * set when a channel link was expanded into one flat list.
   */
  section: string | null
}

export interface PlaylistInfo {
  id: string
  url: string
  title: string
  uploader: string | null
  entries: PlaylistEntry[]
  /**
   * True when the link resolved to a channel rather than a single playlist, so
   * `entries` is the concatenation of its video-bearing tabs.
   */
  isChannel: boolean
}

export type ProbeResult =
  | { kind: 'video'; video: VideoInfo }
  | { kind: 'playlist'; playlist: PlaylistInfo }

/* ------------------------------------------------------------------ */
/* Download requests                                                   */
/* ------------------------------------------------------------------ */

export type AudioCodec = 'mp3' | 'm4a' | 'flac' | 'wav' | 'opus'

export type DownloadSelection =
  /** Genuinely the best streams available: no height cap, no forced container */
  | { mode: 'best' }
  /** Best video+audio capped at a height */
  | { mode: 'quality'; height: number }
  /** A specific format id from the format table */
  | { mode: 'format'; formatId: string; needsAudio: boolean }
  /** Strip to audio only */
  | { mode: 'audio'; codec: AudioCodec; quality: 'best' | '320' | '192' | '128' }

export interface DownloadRequest {
  url: string
  title: string
  /** Channel or author, carried through so history can show it. */
  uploader?: string | null
  thumbnail: string | null
  duration: number | null
  selection: DownloadSelection
  /** Overrides the saved default when present */
  outputDir?: string
  /** Downloads land in a subfolder named after this category */
  categoryId?: string | null
  subtitleLangs?: string[]
  embedSubs?: boolean
  embedThumbnail?: boolean
  embedMetadata?: boolean
  sponsorblock?: boolean
}

/* ------------------------------------------------------------------ */
/* Queue                                                               */
/* ------------------------------------------------------------------ */

export type QueueItemStatus =
  | 'queued'
  | 'probing'
  | 'downloading'
  | 'merging'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'canceled'

export interface QueueItem {
  id: string
  url: string
  title: string
  /** Channel or author when the probe reported one. */
  uploader: string | null
  thumbnail: string | null
  duration: number | null
  selection: DownloadSelection
  categoryId: string | null
  status: QueueItemStatus
  /** 0-100, null before the first progress line arrives */
  percent: number | null
  downloadedBytes: number | null
  totalBytes: number | null
  /** Bytes per second */
  speed: number | null
  /** Seconds remaining */
  eta: number | null
  /** Set once the file lands on disk */
  outputPath: string | null
  error: string | null
  /** Attempts made so far, for retry/backoff display */
  attempts: number
  createdAt: number
  completedAt: number | null
}

/* ------------------------------------------------------------------ */
/* Clipboard capture                                                   */
/* ------------------------------------------------------------------ */

/**
 * A link caught from the clipboard while the app was running, probed in the
 * background so its details are ready before the window is ever opened.
 */
export interface ClipboardEntry {
  id: string
  url: string
  addedAt: number
  status: 'pending' | 'ready' | 'error'
  title: string | null
  uploader: string | null
  thumbnail: string | null
  duration: number | null
  /** Heights offered, descending — shown as chips without a re-probe. */
  qualities: number[]
  /** Estimated bytes for the best available streams. */
  bestSize: number | null
  error: string | null
  /**
   * True when the link resolved to a playlist rather than one video. Downloads
   * pass --no-playlist, so a playlist has to be opened and picked from instead
   * of being grabbed straight from this list.
   */
  isPlaylist: boolean
  /** Full probe result, so downloading from here needs no second network call. */
  info: VideoInfo | null
}

/* ------------------------------------------------------------------ */
/* History                                                             */
/* ------------------------------------------------------------------ */

/**
 * Survives the file itself: kept even after the video is deleted or moved, so
 * the record of what was downloaded is never lost with it.
 */
export interface HistoryEntry {
  id: string
  url: string
  title: string
  uploader: string | null
  thumbnail: string | null
  duration: number | null
  categoryId: string | null
  categoryName: string | null
  outputPath: string | null
  filesize: number | null
  /** Human label of what was downloaded, e.g. "1080p" or "MP3". */
  selectionLabel: string
  completedAt: number
}

/* ------------------------------------------------------------------ */
/* Cookies                                                             */
/* ------------------------------------------------------------------ */

export type CookieBrowser = 'brave' | 'chrome' | 'edge' | 'opera' | 'vivaldi' | 'firefox'

export interface BrowserPresence {
  id: CookieBrowser
  label: string
  /** False when no readable profile for it exists on this account. */
  installed: boolean
  /** Exact folder cookies are read from, surfaced so the choice can be checked. */
  profileDir: string | null
  /** Profile name where a browser keeps several, e.g. "default-release". */
  profileName: string | null
}

/** What the last successful cookie export actually produced. */
export interface CookieStatus {
  browser: CookieBrowser
  cookieCount: number
  /** Cookies scoped to YouTube or Google. */
  youtubeCount: number
  /** True when the jar carries a signed-in Google session, not just visitor cookies. */
  signedIn: boolean
  /** Folder the cookies were read from. */
  profileDir: string | null
  /** Profile name, where the browser keeps more than one. */
  profileName: string | null
  capturedAt: number
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

export interface Settings {
  downloadDir: string
  outputTemplate: string
  concurrency: number
  defaultQuality: number | 'best'
  audioCodec: AudioCodec
  subtitleLangs: string[]
  embedSubs: boolean
  embedThumbnail: boolean
  embedMetadata: boolean
  sponsorblock: boolean
  autoUpdateYtdlp: boolean
  /** Epoch ms of the last `yt-dlp -U` check; 0 means never. */
  lastYtdlpUpdateCheck: number
  accent: string
  autoProbeOnPaste: boolean
  /** Poll the clipboard and offer a detected link, rather than filling it in automatically. */
  watchClipboard: boolean
  /** Keep running in the tray when the window closes, so clipboard capture continues. */
  closeToTray: boolean
  /** Subfolders downloads can be filed into. */
  categories: Category[]
  /** Category preselected in the download UI; null means no category. */
  defaultCategoryId: string | null
  /** Last successful cookie export, or null when no jar has been captured. */
  cookies: CookieStatus | null
}

export interface Category {
  id: string
  name: string
  /** Filesystem-safe subfolder name derived from `name`. */
  folder: string
}

export interface BinaryVersions {
  ytdlp: string | null
  ffmpeg: string | null
}

/** Free/total bytes on the volume holding the download folder. */
export interface DiskSpace {
  free: number
  total: number
}

/* ------------------------------------------------------------------ */
/* Preload surface                                                     */
/* ------------------------------------------------------------------ */

export interface RendererApi {
  /* window chrome */
  window: {
    minimize(): void
    toggleMaximize(): void
    close(): void
    onMaximizeChange(cb: (maximized: boolean) => void): () => void
  }

  /* splash */
  bootstrap: {
    onProgress(cb: (state: BootstrapState) => void): () => void
    retry(): void
    continueAnyway(): void
  }

  /* media */
  media: {
    probe(url: string): Promise<ProbeResult>
    probeEntry(url: string): Promise<VideoInfo>
  }

  /* queue */
  queue: {
    add(requests: DownloadRequest[]): Promise<string[]>
    pause(id: string): Promise<void>
    resume(id: string): Promise<void>
    cancel(id: string): Promise<void>
    retry(id: string): Promise<void>
    remove(id: string): Promise<void>
    clearFinished(): Promise<void>
    list(): Promise<QueueItem[]>
    onUpdate(cb: (items: QueueItem[]) => void): () => void
    onItemProgress(cb: (item: QueueItem) => void): () => void
    getLog(id: string): Promise<string[]>
  }

  /* settings + system */
  settings: {
    get(): Promise<Settings>
    set(patch: Partial<Settings>): Promise<Settings>
    pickDownloadDir(): Promise<string | null>
    versions(): Promise<BinaryVersions>
    updateYtdlp(): Promise<{ ok: boolean; message: string }>
  }

  /* links captured from the clipboard while running in the background */
  clipboardInbox: {
    list(): Promise<ClipboardEntry[]>
    remove(id: string): Promise<void>
    clear(): Promise<void>
    /** Re-probes an entry that failed. */
    retry(id: string): Promise<void>
    onUpdate(cb: (entries: ClipboardEntry[]) => void): () => void
  }

  history: {
    list(): Promise<HistoryEntry[]>
    remove(id: string): Promise<void>
    clear(): Promise<void>
    onUpdate(cb: (entries: HistoryEntry[]) => void): () => void
    /** True when the file is still where we left it. */
    fileExists(path: string): Promise<boolean>
  }

  categories: {
    create(name: string): Promise<Settings>
    remove(id: string): Promise<Settings>
  }

  cookies: {
    /** Which supported browsers have a profile on this machine. */
    browsers(): Promise<BrowserPresence[]>
    /** Exports cookies from one browser; rejects with a message worth showing. */
    capture(browser: CookieBrowser): Promise<Settings>
    /** Deletes the jar so downloads go back to running signed out. */
    clear(): Promise<Settings>
  }

  system: {
    /** Null when the volume cannot be queried, e.g. a disconnected drive. */
    diskSpace(): Promise<DiskSpace | null>
    readClipboard(): Promise<string>
    writeClipboard(text: string): Promise<void>
    openPath(path: string): Promise<void>
    showInFolder(path: string): Promise<void>
    openExternal(url: string): Promise<void>
  }
}
