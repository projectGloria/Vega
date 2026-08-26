import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import type {
  Category,
  DownloadRequest,
  DownloadSelection,
  HistoryEntry,
  QueueItem
} from '@shared/types'
import { run, type RunHandle } from '../ytdlp/runner'
import { buildDownloadArgs, type YtdlpContext } from '../ytdlp/formats'
import {
  isPostProcessLine,
  isRetryableError,
  parseDestinationLine,
  parseFilepathLine,
  parseProgressLine,
  summarizeError
} from '../ytdlp/progress'
import { validateUrl } from '../ytdlp/metadata'
import { saveQueue } from '../store'

/** yt-dlp emits progress far faster than any UI can paint. */
const PROGRESS_EMIT_INTERVAL_MS = 100
const MAX_LOG_LINES = 500
const MAX_ATTEMPTS = 3
const PERSIST_DEBOUNCE_MS = 1000

/** Short human label for what was downloaded, used in history rows. */
export function describeSelection(selection: DownloadSelection): string {
  switch (selection.mode) {
    case 'best':
      return 'Best'
    case 'quality':
      return selection.height + 'p'
    case 'format':
      return 'Format ' + selection.formatId
    case 'audio':
      return selection.codec.toUpperCase()
  }
}

export interface QueueCallbacks {
  onItems(items: QueueItem[]): void
  onProgress(item: QueueItem): void
}

/** Why a running process was killed — the exit handler cannot tell on its own. */
type KillIntent = 'pause' | 'cancel'

export class QueueManager {
  private items = new Map<string, QueueItem>()
  private handles = new Map<string, RunHandle>()
  private intents = new Map<string, KillIntent>()
  private logs = new Map<string, string[]>()
  private lastProgressEmit = new Map<string, number>()
  private retryTimers = new Map<string, NodeJS.Timeout>()
  /** Ids whose path came from after_move, which weaker signals must not clobber. */
  private confirmedPaths = new Set<string>()
  private persistTimer: NodeJS.Timeout | null = null

  constructor(
    private getContext: () => YtdlpContext,
    private getConcurrency: () => number,
    private getDefaults: () => Pick<
      DownloadRequest,
      'subtitleLangs' | 'embedSubs' | 'embedThumbnail' | 'embedMetadata' | 'sponsorblock'
    >,
    private callbacks: QueueCallbacks,
    private getCategory: (id: string | null) => Category | null,
    private onCompleted: (entry: HistoryEntry) => Promise<unknown>
  ) {}

  /* ---------------------------------------------------------------- */
  /* State                                                             */
  /* ---------------------------------------------------------------- */

  list(): QueueItem[] {
    return [...this.items.values()].sort((a, b) => a.createdAt - b.createdAt)
  }

  getLog(id: string): string[] {
    return this.logs.get(id) ?? []
  }

  /** Restores a queue persisted from a previous run. */
  hydrate(items: QueueItem[]): void {
    for (const item of items) this.items.set(item.id, item)
    this.emitItems()
  }

  private emitItems(): void {
    this.callbacks.onItems(this.list())
    this.schedulePersist()
  }

  private schedulePersist(): void {
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      // Never let a failed disk write take down a download in flight.
      saveQueue(this.list()).catch(() => {})
    }, PERSIST_DEBOUNCE_MS)
  }

  private log(id: string, line: string): void {
    let lines = this.logs.get(id)
    if (!lines) {
      lines = []
      this.logs.set(id, lines)
    }
    lines.push(line)
    if (lines.length > MAX_LOG_LINES) lines.splice(0, lines.length - MAX_LOG_LINES)
  }

  private patch(id: string, patch: Partial<QueueItem>, options: { throttle?: boolean } = {}): void {
    const item = this.items.get(id)
    if (!item) return
    Object.assign(item, patch)

    if (options.throttle) {
      const last = this.lastProgressEmit.get(id) ?? 0
      const now = Date.now()
      if (now - last < PROGRESS_EMIT_INTERVAL_MS) return
      this.lastProgressEmit.set(id, now)
      this.callbacks.onProgress({ ...item })
      return
    }

    this.emitItems()
  }

  /* ---------------------------------------------------------------- */
  /* Mutations                                                         */
  /* ---------------------------------------------------------------- */

  add(requests: DownloadRequest[]): string[] {
    const ids: string[] = []

    for (const req of requests) {
      // Validate here as well as at the IPC boundary: this is the value that
      // actually becomes a process argument.
      const url = validateUrl(req.url)
      const id = randomUUID()

      this.items.set(id, {
        id,
        url,
        title: req.title || url,
        uploader: req.uploader ?? null,
        thumbnail: req.thumbnail ?? null,
        duration: req.duration ?? null,
        selection: req.selection,
        categoryId: req.categoryId ?? null,
        status: 'queued',
        percent: null,
        downloadedBytes: null,
        totalBytes: null,
        speed: null,
        eta: null,
        outputPath: null,
        error: null,
        attempts: 0,
        createdAt: Date.now(),
        completedAt: null
      })

      // Per-item overrides are kept alongside the item so a retry reuses them.
      this.requestOptions.set(id, req)
      ids.push(id)
    }

    this.emitItems()
    this.pump()
    return ids
  }

  private requestOptions = new Map<string, DownloadRequest>()

  pause(id: string): void {
    const item = this.items.get(id)
    if (!item) return

    this.clearRetryTimer(id)

    if (item.status === 'queued') {
      this.patch(id, { status: 'paused' })
      return
    }
    if (item.status !== 'downloading' && item.status !== 'merging') return

    // The .part file survives the kill, so resuming continues rather than restarts.
    const handle = this.handles.get(id)
    if (!handle) {
      // The process already exited and its close handler has not landed yet.
      // Without this the row stays on "downloading" with nothing running.
      this.patch(id, { status: 'paused', speed: null, eta: null })
      return
    }
    this.intents.set(id, 'pause')
    handle.kill()
  }

  resume(id: string): void {
    const item = this.items.get(id)
    if (!item || (item.status !== 'paused' && item.status !== 'failed')) return
    this.patch(id, { status: 'queued', error: null, speed: null, eta: null })
    this.pump()
  }

  cancel(id: string): void {
    const item = this.items.get(id)
    if (!item) return

    this.clearRetryTimer(id)

    if (item.status === 'downloading' || item.status === 'merging') {
      this.intents.set(id, 'cancel')
      this.handles.get(id)?.kill()
      return
    }
    this.patch(id, { status: 'canceled', speed: null, eta: null })
  }

  retry(id: string): void {
    const item = this.items.get(id)
    if (!item) return
    this.clearRetryTimer(id)
    this.patch(id, {
      status: 'queued',
      error: null,
      attempts: 0,
      percent: null,
      speed: null,
      eta: null
    })
    this.pump()
  }

  remove(id: string): void {
    const item = this.items.get(id)
    if (!item) return

    this.clearRetryTimer(id)
    if (item.status === 'downloading' || item.status === 'merging') {
      this.intents.set(id, 'cancel')
      this.handles.get(id)?.kill()
    }

    this.items.delete(id)
    this.logs.delete(id)
    this.requestOptions.delete(id)
    this.lastProgressEmit.delete(id)
    this.confirmedPaths.delete(id)
    this.emitItems()
    this.pump()
  }

  /** Pauses everything in flight or waiting — used by the tray menu. */
  pauseAll(): void {
    for (const item of this.list()) {
      if (item.status === 'downloading' || item.status === 'merging' || item.status === 'queued') {
        this.pause(item.id)
      }
    }
  }

  /** Resumes everything the user (or a restart) left paused. */
  resumeAll(): void {
    for (const item of this.list()) {
      if (item.status === 'paused') this.resume(item.id)
    }
  }

  clearFinished(): void {
    for (const item of this.list()) {
      if (item.status === 'completed' || item.status === 'canceled' || item.status === 'failed') {
        this.clearRetryTimer(item.id)
        this.items.delete(item.id)
        this.logs.delete(item.id)
        this.requestOptions.delete(item.id)
        this.lastProgressEmit.delete(item.id)
        this.confirmedPaths.delete(item.id)
        this.intents.delete(item.id)
      }
    }
    this.emitItems()
  }

  /** Kills every running process — used on app quit so nothing is orphaned. */
  shutdown(): void {
    for (const [id, handle] of this.handles) {
      this.intents.set(id, 'pause')
      handle.kill()
    }
    for (const timer of this.retryTimers.values()) clearTimeout(timer)
    this.retryTimers.clear()
  }

  private clearRetryTimer(id: string): void {
    const timer = this.retryTimers.get(id)
    if (timer) {
      clearTimeout(timer)
      this.retryTimers.delete(id)
    }
  }

  /* ---------------------------------------------------------------- */
  /* Scheduling                                                        */
  /* ---------------------------------------------------------------- */

  private get activeCount(): number {
    return this.handles.size
  }

  /** Starts queued items until the concurrency limit is reached. */
  private pump(): void {
    const limit = Math.max(1, this.getConcurrency())

    for (const item of this.list()) {
      if (this.activeCount >= limit) break
      if (item.status !== 'queued') continue
      // An item waiting out its retry backoff is 'queued' but must not start yet.
      if (this.retryTimers.has(item.id)) continue
      this.start(item.id)
    }
  }

  private start(id: string): void {
    const item = this.items.get(id)
    if (!item || this.handles.has(id)) return

    const defaults = this.getDefaults()
    const stored = this.requestOptions.get(id)

    // The category is resolved per-download rather than baked in at enqueue
    // time, so renaming a category before an item starts still files it right.
    const ctx = { ...this.getContext(), categoryFolder: this.resolveCategoryFolder(item.categoryId) }

    const request: DownloadRequest = {
      url: item.url,
      title: item.title,
      uploader: item.uploader,
      thumbnail: item.thumbnail,
      duration: item.duration,
      selection: item.selection,
      categoryId: item.categoryId,
      subtitleLangs: stored?.subtitleLangs ?? defaults.subtitleLangs,
      embedSubs: stored?.embedSubs ?? defaults.embedSubs,
      embedThumbnail: stored?.embedThumbnail ?? defaults.embedThumbnail,
      embedMetadata: stored?.embedMetadata ?? defaults.embedMetadata,
      sponsorblock: stored?.sponsorblock ?? defaults.sponsorblock,
      outputDir: stored?.outputDir
    }

    const args = buildDownloadArgs(request, ctx)
    this.log(id, '$ yt-dlp ' + args.join(' '))

    this.intents.delete(id)
    this.patch(id, {
      status: 'downloading',
      error: null,
      attempts: item.attempts + 1,
      percent: item.percent ?? null
    })

    const handle = run(ctx.ytdlpExe, args, {
      onStdoutLine: (line) => this.handleLine(id, line),
      onStderrLine: (line) => this.handleLine(id, line, true)
    })

    this.handles.set(id, handle)

    handle.done.then(
      (code) => this.finish(id, code, handle.killed),
      (err: Error) => {
        this.log(id, 'Failed to start yt-dlp: ' + err.message)
        this.finish(id, -1, false)
      }
    )
  }

  private resolveCategoryFolder(categoryId: string | null): string | null {
    return this.getCategory(categoryId)?.folder ?? null
  }

  /**
   * Writes the finished download into history. History deliberately outlives
   * the file, so this records the metadata rather than pointing only at a path
   * that may later be moved or deleted.
   */
  private async recordHistory(id: string): Promise<void> {
    const item = this.items.get(id)
    if (!item) return

    const category = this.getCategory(item.categoryId)
    let filesize: number | null = item.totalBytes

    if (item.outputPath) {
      // The merged file's real size is more accurate than the download total,
      // which counts the separate video and audio streams before muxing.
      filesize = await stat(item.outputPath)
        .then((s) => s.size)
        .catch(() => item.totalBytes)
    }

    await this.onCompleted({
      id: randomUUID(),
      url: item.url,
      title: item.title,
      uploader: item.uploader,
      thumbnail: item.thumbnail,
      duration: item.duration,
      categoryId: item.categoryId,
      categoryName: category?.name ?? null,
      outputPath: item.outputPath,
      filesize,
      selectionLabel: describeSelection(item.selection),
      completedAt: Date.now()
    }).catch(() => {
      // History is a convenience; never fail a finished download over it.
    })

    // The queue is for work in progress. Once it is safely in history, a
    // finished item leaves — history is where completed downloads live.
    this.items.delete(id)
    this.logs.delete(id)
    this.requestOptions.delete(id)
    this.confirmedPaths.delete(id)
    this.emitItems()
  }

  private handleLine(id: string, line: string, isStderr = false): void {
    const progress = parseProgressLine(line)
    if (progress) {
      const item = this.items.get(id)
      // Once post-processing starts, the streams are already on disk. yt-dlp
      // still emits progress for the thumbnail it fetches for embedding, and
      // that line was dragging a merging row back to "downloading" at 3%.
      if (item && item.status === 'merging') return

      this.patch(
        id,
        {
          status: 'downloading',
          percent: progress.percent,
          downloadedBytes: progress.downloadedBytes,
          totalBytes: progress.totalBytes,
          speed: progress.speed,
          eta: progress.eta
        },
        { throttle: true }
      )
      return
    }

    // after_move is authoritative and always wins.
    const filepath = parseFilepathLine(line)
    if (filepath) {
      this.patch(id, { outputPath: filepath })
      this.confirmedPaths.add(id)
      return
    }

    this.log(id, line)

    // Weaker signals fill the gap when after_move never fires, but must never
    // overwrite a path it already gave us.
    if (!this.confirmedPaths.has(id)) {
      const fallback = parseDestinationLine(line)
      if (fallback) this.patch(id, { outputPath: fallback })
    }

    if (isPostProcessLine(line)) {
      this.patch(id, { status: 'merging', percent: 100, speed: null, eta: null })
      return
    }

    if (isStderr && line.includes('ERROR:')) {
      // Recorded now, surfaced on exit — yt-dlp may still recover from some errors.
      this.patch(id, {}, { throttle: true })
    }
  }

  private finish(id: string, code: number | null, wasKilled: boolean): void {
    this.handles.delete(id)
    this.lastProgressEmit.delete(id)

    const item = this.items.get(id)
    if (!item) {
      this.pump()
      return
    }

    if (wasKilled) {
      const intent = this.intents.get(id) ?? 'cancel'
      this.intents.delete(id)
      this.patch(id, {
        status: intent === 'pause' ? 'paused' : 'canceled',
        speed: null,
        eta: null
      })
      this.pump()
      return
    }

    if (code === 0) {
      this.patch(id, {
        status: 'completed',
        percent: 100,
        speed: null,
        eta: null,
        error: null,
        completedAt: Date.now()
      })
      void this.recordHistory(id)
      this.pump()
      return
    }

    const message = summarizeError(this.logs.get(id) ?? [])

    // Retry only what a retry can actually fix. Looping on "video unavailable"
    // just hides the real reason from the user.
    if (item.attempts < MAX_ATTEMPTS && isRetryableError(message)) {
      const delayMs = 2000 * Math.pow(2, item.attempts - 1)
      this.patch(id, {
        status: 'queued',
        error: message + ' — retrying…',
        speed: null,
        eta: null
      })
      this.retryTimers.set(
        id,
        setTimeout(() => {
          this.retryTimers.delete(id)
          this.pump()
        }, delayMs)
      )
      this.pump()
      return
    }

    this.patch(id, { status: 'failed', error: message, speed: null, eta: null })
    this.pump()
  }
}
