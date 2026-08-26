import { randomUUID } from 'node:crypto'
import type { ClipboardEntry, VideoInfo } from '@shared/types'
import { probe } from './ytdlp/metadata'
import { estimateBestSize, type YtdlpContext } from './ytdlp/formats'
import {
  getClipboardEntries,
  loadClipboardEntries,
  saveClipboardEntries
} from './store'
import { log } from './log'
import { isMediaUrl } from './media-sites'

/**
 * Probing runs one at a time. The whole point of this feature is that the app
 * sits quietly in the background — firing a burst of yt-dlp processes because
 * someone copied five links in a row would defeat that.
 */
const MAX_CONCURRENT_PROBES = 1

/**
 * Canonical key for "is this the same video?".
 *
 * The same video reaches the clipboard in several shapes — youtu.be/ID, a
 * watch?v=ID URL, the same link with a &t= timestamp or tracking parameters.
 * Comparing raw strings would treat all of those as different videos and
 * re-add something already downloaded.
 */
export function videoKey(raw: string): string {
  try {
    const url = new URL(raw)
    const host = url.hostname.replace(/^www\./, '').toLowerCase()

    if (host === 'youtu.be') {
      return 'yt:' + url.pathname.slice(1).split('/')[0]
    }
    if (host.endsWith('youtube.com')) {
      const v = url.searchParams.get('v')
      if (v) return 'yt:' + v
      const shorts = url.pathname.match(/^\/shorts\/([^/]+)/)
      if (shorts) return 'yt:' + shorts[1]
    }

    // Everything else: host + path, ignoring query, fragment and trailing slash.
    return host + url.pathname.replace(/\/+$/, '')
  } catch {
    return raw.trim()
  }
}

export function sameVideo(a: string, b: string): boolean {
  return videoKey(a) === videoKey(b)
}

export class ClipboardInbox {
  private entries: ClipboardEntry[] = []
  private queue: string[] = []
  private active = 0

  constructor(
    private getContext: () => YtdlpContext,
    private onChange: (entries: ClipboardEntry[]) => void,
    /** Lets the inbox skip links already queued, downloading, or downloaded. */
    private isKnown: (url: string) => boolean = () => false
  ) {}

  async load(): Promise<void> {
    const stored = await loadClipboardEntries()

    // Links captured before the media-site gate existed are still sitting here
    // as failed rows nobody can act on. They were never downloadable, so they
    // are dropped rather than left for the user to clear by hand.
    // `isPlaylist` postdates the first releases, so a stored entry may not
    // carry it; absent means "not a playlist", which is the safe reading.
    this.entries = stored
      .filter((e) => isMediaUrl(e.url))
      .map((e) => ({ ...e, isPlaylist: e.isPlaylist === true }))

    const dropped = stored.length - this.entries.length
    if (dropped > 0) log.info('dropped ' + dropped + ' clipboard entries that are not media links')

    this.emit()
  }

  list(): ClipboardEntry[] {
    return this.entries
  }

  private emit(): void {
    this.onChange(this.entries)
    void saveClipboardEntries(this.entries)
  }

  /** Called by the clipboard watcher for every new link it sees. */
  add(url: string): void {
    // The watcher filters these out already; this is the backstop for anything
    // that reaches the inbox by another route.
    if (!isMediaUrl(url)) {
      log.info('ignoring non-media clipboard link:', url)
      return
    }

    // Re-copying a link you already have should not create a duplicate row.
    if (this.entries.some((e) => sameVideo(e.url, url))) return

    // Nor should a link that is already queued, downloading, or in history —
    // copying a URL again is not a request to download it twice.
    if (this.isKnown(url)) {
      log.info('clipboard link already known, not adding to inbox:', url)
      return
    }

    const entry: ClipboardEntry = {
      id: randomUUID(),
      url,
      addedAt: Date.now(),
      status: 'pending',
      title: null,
      uploader: null,
      thumbnail: null,
      duration: null,
      qualities: [],
      bestSize: null,
      error: null,
      isPlaylist: false,
      info: null
    }

    this.entries = [entry, ...this.entries]
    this.emit()

    this.queue.push(entry.id)
    this.pump()
  }

  retry(id: string): void {
    const entry = this.entries.find((e) => e.id === id)
    if (!entry || entry.status === 'pending') return

    this.patch(id, { status: 'pending', error: null })
    this.queue.push(id)
    this.pump()
  }

  remove(id: string): void {
    this.entries = this.entries.filter((e) => e.id !== id)
    this.queue = this.queue.filter((q) => q !== id)
    this.emit()
  }

  clear(): void {
    this.entries = []
    this.queue = []
    this.emit()
  }

  private patch(id: string, patch: Partial<ClipboardEntry>): void {
    this.entries = this.entries.map((e) => (e.id === id ? { ...e, ...patch } : e))
    this.emit()
  }

  private pump(): void {
    while (this.active < MAX_CONCURRENT_PROBES && this.queue.length > 0) {
      const id = this.queue.shift()
      if (id) void this.probeEntry(id)
    }
  }

  private async probeEntry(id: string): Promise<void> {
    const entry = this.entries.find((e) => e.id === id)
    if (!entry) return

    this.active++
    try {
      // Background work: enough to label the link, not a full channel walk.
      const result = await probe(entry.url, this.getContext(), { expandLists: false })

      if (result.kind === 'playlist') {
        // A playlist has no single thumbnail or format list; record what it is
        // and let the user open it in the download view.
        this.patch(id, {
          status: 'ready',
          title: result.playlist.title,
          uploader: result.playlist.uploader,
          thumbnail: result.playlist.entries[0]?.thumbnail ?? null,
          duration: null,
          qualities: [],
          bestSize: null,
          // Downloads pass --no-playlist, so a one-click grab from here would
          // silently fetch only the first video. The row offers "Open" instead.
          isPlaylist: true,
          error: null,
          info: null
        })
        return
      }

      const info: VideoInfo = result.video
      this.patch(id, {
        status: 'ready',
        title: info.title,
        uploader: info.uploader,
        thumbnail: info.thumbnail,
        duration: info.duration,
        qualities: info.qualities,
        bestSize: estimateBestSize(info),
        isPlaylist: false,
        info,
        error: null
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn('clipboard probe failed for', entry.url, message)
      this.patch(id, { status: 'error', error: message.slice(0, 200) })
    } finally {
      this.active--
      this.pump()
    }
  }
}

export function currentEntries(): ClipboardEntry[] {
  return getClipboardEntries()
}
