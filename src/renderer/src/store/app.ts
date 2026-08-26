import { create } from 'zustand'
import type {
  BinaryVersions,
  ClipboardEntry,
  CookieBrowser,
  DownloadRequest,
  DownloadSelection,
  HistoryEntry,
  PlaylistInfo,
  QueueItem,
  Settings,
  VideoInfo
} from '@shared/types'

export type ProbeStatus = 'idle' | 'loading' | 'ready' | 'error'

export type View = 'downloads' | 'queue' | 'clipboard' | 'history' | 'settings'

/**
 * What the picker in the URL bar is set to before a link has been read.
 *
 * Deliberately session-only: it seeds the format the download sheet opens on,
 * which is a per-link decision. The persistent preference lives in Settings, and
 * quietly rewriting it every time someone grabbed one song as audio would make
 * that setting mean nothing.
 */
export type QuickQuality = 'best' | 'audio' | number

/**
 * What is known about one playlist row on its own.
 *
 * A flat playlist probe returns a title and little else, so every row starts
 * `idle` and is filled in by its own probe once it scrolls into view.
 */
export interface EntryDetail {
  status: 'idle' | 'loading' | 'ready' | 'error'
  info: VideoInfo | null
  error: string | null
}

export const IDLE_DETAIL: EntryDetail = { status: 'idle', info: null, error: null }

interface AppState {
  /* settings */
  settings: Settings | null
  versions: BinaryVersions

  /* probe */
  url: string
  probeStatus: ProbeStatus
  probeError: string | null
  video: VideoInfo | null
  playlist: PlaylistInfo | null
  /** Playlist entry urls the user has ticked */
  selectedEntries: Set<string>
  /** Per-row probe results, keyed by entry url. Missing means never asked for. */
  entryDetails: Record<string, EntryDetail>
  /**
   * Rows the user has given a format of their own, keyed by entry url.
   * A row that is absent follows the batch picker instead.
   */
  entrySelections: Record<string, DownloadSelection>

  /** The download sheet, which is where a read link is turned into a download. */
  sheetOpen: boolean
  quickQuality: QuickQuality

  /* queue */
  queue: QueueItem[]

  /* sidebar + sections */
  view: View
  inbox: ClipboardEntry[]
  history: HistoryEntry[]
  /** null means "All"; otherwise a category id to filter history by. */
  historyFilter: string | null
  /** Category applied to new downloads. */
  activeCategoryId: string | null

  /* actions */
  setView(view: View): void
  setInbox(entries: ClipboardEntry[]): void
  setHistory(entries: HistoryEntry[]): void
  setHistoryFilter(id: string | null): void
  setActiveCategory(id: string | null): void
  loadInboxAndHistory(): Promise<void>
  createCategory(name: string): Promise<void>
  removeCategory(id: string): Promise<void>
  captureCookies(browser: CookieBrowser): Promise<void>
  clearCookies(): Promise<void>
  setUrl(url: string): void
  setQuickQuality(quality: QuickQuality): void
  loadSettings(): Promise<void>
  saveSettings(patch: Partial<Settings>): Promise<void>
  probe(url: string): Promise<void>
  clearProbe(): void
  /** Opens the sheet on a link, probing it unless a fresh result is already in. */
  openSheet(url: string): void
  closeSheet(): void
  toggleEntry(url: string): void
  setAllEntries(selected: boolean): void
  /** Queues a row's own probe; repeated calls for the same row are ignored. */
  requestEntryDetail(url: string): void
  /** Re-probes a row that failed. */
  retryEntryDetail(url: string): void
  /** Queues every row, for when the whole list needs sizes rather than a screenful. */
  requestAllEntryDetails(): void
  /** null drops the override, putting the row back on the batch format. */
  setEntrySelection(url: string, selection: DownloadSelection | null): void
  clearEntrySelections(): void
  enqueue(requests: DownloadRequest[]): Promise<void>
  setQueue(items: QueueItem[]): void
  patchQueueItem(item: QueueItem): void
}

/** Guards against a slow probe landing after the user has typed a new link. */
let probeToken = 0

export const useApp = create<AppState>((set, get) => ({
  settings: null,
  versions: { ytdlp: null, ffmpeg: null },

  url: '',
  probeStatus: 'idle',
  probeError: null,
  video: null,
  playlist: null,
  selectedEntries: new Set(),
  entryDetails: {},
  entrySelections: {},

  sheetOpen: false,
  quickQuality: 'best',

  queue: [],

  view: 'downloads',
  inbox: [],
  history: [],
  historyFilter: null,
  activeCategoryId: null,

  setView: (view) => set({ view }),
  setInbox: (inbox) => set({ inbox }),
  setHistory: (history) => set({ history }),
  setHistoryFilter: (historyFilter) => set({ historyFilter }),
  setActiveCategory: (activeCategoryId) => set({ activeCategoryId }),
  setQuickQuality: (quickQuality) => set({ quickQuality }),

  async loadInboxAndHistory() {
    const [inbox, history] = await Promise.all([
      window.api.clipboardInbox.list(),
      window.api.history.list()
    ])
    set({ inbox, history })
  },

  async createCategory(name) {
    const settings = await window.api.categories.create(name)
    set({ settings })
  },

  async captureCookies(browser) {
    const settings = await window.api.cookies.capture(browser)
    set({ settings })
  },

  async clearCookies() {
    const settings = await window.api.cookies.clear()
    set({ settings })
  },

  async removeCategory(id) {
    const settings = await window.api.categories.remove(id)
    set((state) => ({
      settings,
      // Drop references to a category that no longer exists.
      activeCategoryId: state.activeCategoryId === id ? null : state.activeCategoryId,
      historyFilter: state.historyFilter === id ? null : state.historyFilter
    }))
  },

  setUrl: (url) => set({ url }),

  async loadSettings() {
    const [settings, versions] = await Promise.all([
      window.api.settings.get(),
      window.api.settings.versions()
    ])
    set((state) => ({
      settings,
      versions,
      // Only seed from the saved default on first load; don't stomp a choice
      // the user just made in the picker.
      activeCategoryId: state.settings ? state.activeCategoryId : settings.defaultCategoryId,
      quickQuality: state.settings ? state.quickQuality : settings.defaultQuality
    }))
    applyAccent(settings.accent)
  },

  async saveSettings(patch) {
    const settings = await window.api.settings.set(patch)
    set({ settings })
    if (patch.accent) applyAccent(settings.accent)
  },

  async probe(url) {
    const token = ++probeToken
    // A new link means the old list's rows are gone; drop what was queued for
    // them so their probes cannot land in the new list.
    resetDetailQueue()
    set({
      probeStatus: 'loading',
      probeError: null,
      video: null,
      playlist: null,
      entryDetails: {},
      entrySelections: {}
    })

    try {
      const result = await window.api.media.probe(url)
      if (token !== probeToken) return

      if (result.kind === 'video') {
        set({ probeStatus: 'ready', video: result.video, playlist: null, selectedEntries: new Set() })
      } else {
        set({
          probeStatus: 'ready',
          playlist: result.playlist,
          video: null,
          // Everything is selected by default; deselecting is the rarer action.
          selectedEntries: new Set(result.playlist.entries.map((e) => e.url))
        })
      }
    } catch (err) {
      if (token !== probeToken) return
      set({
        probeStatus: 'error',
        probeError: err instanceof Error ? cleanIpcError(err.message) : String(err)
      })
    }
  },

  clearProbe: () => {
    probeToken++
    resetDetailQueue()
    set({
      url: '',
      probeStatus: 'idle',
      probeError: null,
      video: null,
      playlist: null,
      selectedEntries: new Set(),
      entryDetails: {},
      entrySelections: {}
    })
  },

  openSheet: (url) => {
    const state = get()
    set({ url, sheetOpen: true, view: 'downloads' })

    // Pasting already kicked off a probe for this exact link; re-running it
    // would throw away a result that is sitting right there and make the sheet
    // spin for a second for nothing.
    const alreadyRead =
      state.url.trim() === url.trim() &&
      (state.probeStatus === 'ready' || state.probeStatus === 'loading')
    if (!alreadyRead) void get().probe(url)
  },

  closeSheet: () => set({ sheetOpen: false }),

  toggleEntry: (url) =>
    set((state) => {
      const next = new Set(state.selectedEntries)
      if (next.has(url)) next.delete(url)
      else next.add(url)
      return { selectedEntries: next }
    }),

  setAllEntries: (selected) =>
    set((state) => ({
      selectedEntries: selected
        ? new Set(state.playlist?.entries.map((e) => e.url) ?? [])
        : new Set()
    })),

  requestEntryDetail: (url) => enqueueDetail(url),

  retryEntryDetail: (url) => {
    detailRequested.delete(url)
    enqueueDetail(url)
  },

  requestAllEntryDetails: () => {
    const entries = get().playlist?.entries ?? []
    // Reversed, because the queue is drained newest-first: this leaves the top
    // of the list — the part on screen — being fetched first.
    for (let i = entries.length - 1; i >= 0; i--) enqueueDetail(entries[i].url)
  },

  setEntrySelection: (url, selection) =>
    set((state) => {
      const next = { ...state.entrySelections }
      if (selection) next[url] = selection
      else delete next[url]
      return { entrySelections: next }
    }),

  clearEntrySelections: () => set({ entrySelections: {} }),

  async enqueue(requests) {
    if (requests.length === 0) return
    await window.api.queue.add(requests)
    set({ sheetOpen: false })
    get().clearProbe()
  },

  setQueue: (queue) => set({ queue }),

  /** Progress arrives per item at up to 10Hz; patch in place, don't refetch. */
  patchQueueItem: (item) =>
    set((state) => ({
      queue: state.queue.map((existing) => (existing.id === item.id ? item : existing))
    }))
}))

/* ------------------------------------------------------------------ */
/* Per-entry detail queue                                              */
/* ------------------------------------------------------------------ */

/**
 * Each row's details cost one yt-dlp run, so a 300-video channel cannot simply
 * ask for all of them at once. Rows queue themselves as they scroll into view
 * and this drains the queue a few at a time.
 *
 * Deliberately last-in-first-out: someone who flings the list to item 200 is
 * looking at item 200, and a FIFO queue would make them wait out the 190 rows
 * they scrolled past. Main caps concurrency again on its side; this cap is
 * about not queuing work the user has already scrolled away from.
 */
const DETAIL_CONCURRENCY = 4

let detailToken = 0
let detailActive = 0
const detailQueue: string[] = []
const detailRequested = new Set<string>()

function resetDetailQueue(): void {
  detailToken++
  detailQueue.length = 0
  detailRequested.clear()
}

function enqueueDetail(url: string): void {
  if (detailRequested.has(url)) return
  detailRequested.add(url)
  detailQueue.push(url)
  pumpDetails()
}

function pumpDetails(): void {
  while (detailActive < DETAIL_CONCURRENCY && detailQueue.length > 0) {
    const url = detailQueue.pop()
    if (url) void loadDetail(url)
  }
}

function patchDetail(url: string, detail: EntryDetail): void {
  useApp.setState((state) => ({ entryDetails: { ...state.entryDetails, [url]: detail } }))
}

async function loadDetail(url: string): Promise<void> {
  const token = detailToken
  detailActive++
  patchDetail(url, { status: 'loading', info: null, error: null })

  try {
    const info = await window.api.media.probeEntry(url)
    // The list this row belonged to may be gone by now.
    if (token === detailToken) patchDetail(url, { status: 'ready', info, error: null })
  } catch (err) {
    if (token === detailToken) {
      patchDetail(url, {
        status: 'error',
        info: null,
        error: err instanceof Error ? cleanIpcError(err.message) : String(err)
      })
    }
  } finally {
    detailActive--
    pumpDetails()
  }
}

/** Electron prefixes IPC rejections with the handler name; strip it for display. */
function cleanIpcError(message: string): string {
  return message.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')
}

/**
 * The accent is a gradient, but only its first stop is persisted.
 *
 * Storing one colour keeps settings.json readable and keeps a hand-edited value
 * working; the second stop is looked up here. An accent that predates this table
 * — or one typed in by hand — simply resolves to a flat gradient rather than an
 * arbitrary second colour nobody chose.
 */
export const ACCENT_THEMES: { name: string; from: string; to: string }[] = [
  { name: 'Stellar', from: '#38bdf8', to: '#6366f1' },
  { name: 'Nebula', from: '#a78bfa', to: '#ec4899' },
  { name: 'Aurora', from: '#34d399', to: '#0ea5e9' },
  { name: 'Solar', from: '#fbbf24', to: '#f472b6' },
  { name: 'Ember', from: '#f87171', to: '#f59e0b' },
  // The pre-Vega default, kept so an existing settings.json still gets a
  // gradient rather than degrading to a single flat colour.
  { name: 'Periwinkle', from: '#6d8bff', to: '#9b7bff' }
]

export function accentPair(accent: string): { from: string; to: string } {
  const match = ACCENT_THEMES.find((t) => t.from.toLowerCase() === accent.trim().toLowerCase())
  return match ?? { from: accent, to: accent }
}

function applyAccent(accent: string): void {
  const { from, to } = accentPair(accent)
  const root = document.documentElement
  root.style.setProperty('--accent', from)
  root.style.setProperty('--accent-2', to)
  root.style.setProperty('--accent-soft', hexToRgba(from, 0.12))
  root.style.setProperty('--accent-line', hexToRgba(from, 0.35))
}

function hexToRgba(hex: string, alpha: number): string {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!match) return 'rgba(56, 189, 248, ' + alpha + ')'
  const value = parseInt(match[1], 16)
  const r = (value >> 16) & 255
  const g = (value >> 8) & 255
  const b = value & 255
  return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + alpha + ')'
}
