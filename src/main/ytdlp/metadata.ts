import type {
  PlaylistEntry,
  PlaylistInfo,
  ProbeResult,
  SubtitleTrack,
  VideoInfo
} from '@shared/types'
import { runCapture } from './runner'
import { baseArgs, normalizeFormats, qualityChips, type YtdlpContext } from './formats'

/**
 * Rejects anything that is not a plain http(s) URL before it reaches yt-dlp.
 * The renderer validates too, but this is the boundary that actually matters —
 * it is the last check before a value becomes a process argument.
 */
export function validateUrl(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) throw new Error('Enter a link first.')

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error('That does not look like a valid link.')
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http and https links are supported.')
  }
  return parsed.toString()
}

interface RawSubtitles {
  [lang: string]: { name?: string }[]
}

function normalizeSubtitles(subs: RawSubtitles = {}, auto: RawSubtitles = {}): SubtitleTrack[] {
  const tracks: SubtitleTrack[] = []

  for (const [lang, entries] of Object.entries(subs)) {
    tracks.push({ lang, name: entries?.[0]?.name ?? lang, auto: false })
  }
  // Auto-captions are offered too, but marked, since their quality varies.
  for (const [lang, entries] of Object.entries(auto)) {
    if (tracks.some((t) => t.lang === lang)) continue
    tracks.push({ lang, name: entries?.[0]?.name ?? lang, auto: true })
  }

  return tracks.sort((a, b) => Number(a.auto) - Number(b.auto) || a.lang.localeCompare(b.lang))
}

function toVideoInfo(json: Record<string, unknown>, fallbackUrl: string): VideoInfo {
  const duration = typeof json.duration === 'number' ? json.duration : null

  // Duration lets sizes be derived from bitrate when the site reports no
  // filesize, which is the common case for DASH video streams.
  const formats = normalizeFormats(
    Array.isArray(json.formats) ? (json.formats as never[]) : [],
    duration
  )

  return {
    id: String(json.id ?? ''),
    url: String(json.webpage_url ?? json.original_url ?? fallbackUrl),
    title: String(json.title ?? 'Untitled'),
    uploader: (json.uploader as string) ?? (json.channel as string) ?? null,
    duration,
    thumbnail: (json.thumbnail as string) ?? null,
    extractor: (json.extractor_key as string) ?? null,
    isLive: json.is_live === true,
    formats,
    subtitles: normalizeSubtitles(
      json.subtitles as RawSubtitles,
      json.automatic_captions as RawSubtitles
    ),
    qualities: qualityChips(formats)
  }
}

interface RawEntry {
  /** 'url' for a flat video, 'playlist' for a channel tab or a nested list. */
  _type?: string
  ie_key?: string
  id?: string
  url?: string
  webpage_url?: string
  title?: string
  duration?: number | null
  thumbnails?: { url?: string }[]
  thumbnail?: string | null
  uploader?: string | null
  channel?: string | null
  /** A channel tab arrives with its own videos already inside it. */
  entries?: RawEntry[]
}

/** A tab or sub-list yt-dlp returns in place of videos for a channel link. */
interface NestedList {
  url: string
  title: string
}

function isNestedList(entry: RawEntry): boolean {
  return (
    entry._type === 'playlist' ||
    entry._type === 'multi_video' ||
    entry.ie_key === 'YoutubeTab' ||
    entry.ie_key === 'YoutubePlaylist'
  )
}

/**
 * The tab name on its own.
 *
 * yt-dlp titles a channel tab "Vsauce - Videos"; repeating the channel name on
 * every row would push the part that actually distinguishes them off the end.
 */
function sectionLabel(title: string): string {
  const tail = title.split(' - ').pop()?.trim()
  return tail && tail.length > 0 ? tail : title.trim()
}

function toEntry(raw: RawEntry, section: string | null): PlaylistEntry {
  return {
    id: String(raw.id ?? ''),
    url: String(raw.webpage_url ?? raw.url),
    title: String(raw.title ?? 'Untitled'),
    uploader: raw.uploader ?? raw.channel ?? null,
    duration: typeof raw.duration === 'number' ? raw.duration : null,
    // Flat entries carry a thumbnail list rather than a single URL, smallest
    // first — the last one is the one worth showing.
    thumbnail: raw.thumbnail ?? raw.thumbnails?.[raw.thumbnails.length - 1]?.url ?? null,
    section
  }
}

/**
 * Flattens one payload into the videos it leads to.
 *
 * A channel is a list of tabs rather than of videos, and `-J --flat-playlist`
 * hands those tabs back with their videos already inside them — so the usual
 * case is a walk, not a second network call. `nested` collects only the sub-
 * lists that arrived empty, which have to be fetched on their own.
 */
const MAX_LIST_DEPTH = 2

function collectEntries(
  raw: RawEntry[],
  section: string | null,
  depth: number,
  entries: PlaylistEntry[],
  nested: NestedList[]
): void {
  for (const item of raw) {
    if (!item) continue
    const url = item.webpage_url ?? item.url

    if (isNestedList(item)) {
      const label = sectionLabel(String(item.title ?? 'Videos'))
      const inline = Array.isArray(item.entries) ? item.entries : []

      if (inline.length > 0) {
        if (depth < MAX_LIST_DEPTH) collectEntries(inline, label, depth + 1, entries, nested)
      } else if (url) {
        nested.push({ url: String(url), title: label })
      }
      continue
    }

    if (!url) continue
    entries.push(toEntry(item, section))
  }
}

function splitEntries(
  json: Record<string, unknown>,
  section: string | null
): { entries: PlaylistEntry[]; nested: NestedList[] } {
  const raw = Array.isArray(json.entries) ? (json.entries as RawEntry[]) : []
  const entries: PlaylistEntry[] = []
  const nested: NestedList[] = []

  collectEntries(raw, section, 0, entries, nested)
  return { entries, nested }
}

function toPlaylistInfo(json: Record<string, unknown>, fallbackUrl: string): PlaylistInfo {
  return {
    id: String(json.id ?? ''),
    url: String(json.webpage_url ?? fallbackUrl),
    title: String(json.title ?? 'Playlist'),
    uploader: (json.uploader as string) ?? (json.channel as string) ?? null,
    entries: [],
    isChannel: false
  }
}

/** Short-lived cache so re-pasting the same link feels instant. */
const CACHE_TTL_MS = 5 * 60 * 1000
/**
 * `expanded` is false only for a channel that was read without walking its
 * tabs, so a later caller that does need the videos re-probes instead of being
 * handed an empty list.
 */
const cache = new Map<string, { at: number; result: ProbeResult; expanded: boolean }>()

/**
 * Entry details are cached separately and for longer: a row is probed with
 * --no-playlist, which can resolve differently from the same URL pasted on its
 * own, and re-opening a 200-item channel must not re-fetch every row.
 */
const ENTRY_CACHE_TTL_MS = 30 * 60 * 1000
const entryCache = new Map<string, { at: number; info: VideoInfo }>()

export function clearProbeCache(): void {
  cache.clear()
  entryCache.clear()
}

function flatProbeArgs(ctx: YtdlpContext, url: string, limit?: number): string[] {
  return [
    ...baseArgs(ctx),
    '-J',
    '--flat-playlist',
    ...(limit ? ['--playlist-end', String(limit)] : []),
    '--no-warnings',
    '--socket-timeout',
    '20',
    '--',
    url
  ]
}

async function flatProbeJson(
  ctx: YtdlpContext,
  url: string,
  timeoutMs?: number,
  limit?: number
): Promise<Record<string, unknown>> {
  let stdout: string
  try {
    ;({ stdout } = await runCapture(ctx.ytdlpExe, flatProbeArgs(ctx, url, limit), timeoutMs))
  } catch (err) {
    throw new Error(cleanProbeError(err))
  }

  try {
    return JSON.parse(stdout) as Record<string, unknown>
  } catch {
    throw new Error('Could not read the video details for that link.')
  }
}

/**
 * Fetches the sub-lists that came back without their videos inside them.
 *
 * YouTube inlines a channel tab's videos, so this is the fallback for the sites
 * that do not — bounded to a handful of lists, because a channel page also
 * points at its own playlists, whose videos are already in the Videos tab.
 */
const MAX_NESTED_LISTS = 4
/** A channel is paginated; walking one takes far longer than a video probe. */
const LIST_PROBE_TIMEOUT_MS = 240_000

async function expandNested(ctx: YtdlpContext, nested: NestedList[]): Promise<PlaylistEntry[]> {
  const collected: PlaylistEntry[] = []

  for (const list of nested.slice(0, MAX_NESTED_LISTS)) {
    let json: Record<string, unknown>
    try {
      json = await flatProbeJson(ctx, list.url, LIST_PROBE_TIMEOUT_MS)
    } catch {
      // One empty or members-only tab must not sink the whole channel.
      continue
    }
    // Deliberately not recursive: only the videos this tab lists directly.
    collected.push(...splitEntries(json, sectionLabel(list.title)).entries)
  }

  return collected
}

function dedupeEntries(entries: PlaylistEntry[]): PlaylistEntry[] {
  const seen = new Set<string>()
  return entries.filter((entry) => {
    const key = entry.id || entry.url
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * One `-J --flat-playlist` call distinguishes a video from a playlist:
 * a video URL still returns its full format list, while a playlist returns
 * lightweight entries instead of extracting every item up front.
 *
 * Per-entry details — formats, sizes, the real thumbnail — are deliberately not
 * fetched here. That is one yt-dlp run per video, which for a channel means
 * hundreds; `probeEntry` fills them in for the rows the user actually looks at.
 */
export interface ProbeOptions {
  /**
   * Walk a channel's tabs into a flat list of videos. On by default, but the
   * clipboard watcher turns it off: it only needs to know that a copied link is
   * a list, and paging through a whole channel in the background for that would
   * cost minutes of extraction nobody asked for.
   */
  expandLists?: boolean
}

export async function probe(
  url: string,
  ctx: YtdlpContext,
  options: ProbeOptions = {}
): Promise<ProbeResult> {
  const safeUrl = validateUrl(url)
  const expandLists = options.expandLists !== false

  const cached = cache.get(safeUrl)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS && (cached.expanded || !expandLists)) {
    return cached.result
  }

  // Reading a link only to label it needs its first row and nothing else — and
  // a channel walked in full is minutes of extraction, not seconds.
  const json = await flatProbeJson(
    ctx,
    safeUrl,
    LIST_PROBE_TIMEOUT_MS,
    expandLists ? undefined : 1
  )

  let result: ProbeResult
  let expanded = true

  if (json._type === 'playlist' || json._type === 'multi_video') {
    const info = toPlaylistInfo(json, safeUrl)
    const { entries, nested } = splitEntries(json, null)
    const fromLists = nested.length > 0 && expandLists ? await expandNested(ctx, nested) : []

    info.entries = dedupeEntries([...entries, ...fromLists])
    // Tabs are the tell: a plain playlist has no sections, a channel is nothing
    // but sections.
    info.isChannel = info.entries.some((entry) => entry.section !== null)
    // A capped read is a truncated list, whatever kind of link it was.
    expanded = expandLists

    result = { kind: 'playlist', playlist: info }
  } else {
    result = { kind: 'video', video: toVideoInfo(json, safeUrl) }
  }

  cache.set(safeUrl, { at: Date.now(), result, expanded })
  return result
}

/**
 * `--no-playlist` is load-bearing here: a playlist row's URL is usually of the
 * form `watch?v=...&list=...`, and without it yt-dlp resolves the *list* again
 * and this returns the playlist we are already looking at.
 */
async function runEntryProbe(url: string, ctx: YtdlpContext): Promise<VideoInfo> {
  const args = [
    ...baseArgs(ctx),
    '-J',
    '--no-playlist',
    '--no-warnings',
    '--socket-timeout',
    '20',
    '--',
    url
  ]

  let stdout: string
  try {
    ;({ stdout } = await runCapture(ctx.ytdlpExe, args))
  } catch (err) {
    throw new Error(cleanProbeError(err))
  }

  let json: Record<string, unknown>
  try {
    json = JSON.parse(stdout) as Record<string, unknown>
  } catch {
    throw new Error('Could not read the video details for that link.')
  }

  if (json._type === 'playlist' || json._type === 'multi_video') {
    throw new Error('That link is a playlist, not a single video.')
  }

  return toVideoInfo(json, url)
}

/**
 * Every entry probe is a process, and the renderer asks for a screenful at a
 * time. Without a ceiling, scrolling a channel spawns yt-dlp faster than the
 * machine retires it.
 */
const ENTRY_PROBE_CONCURRENCY = 3
let activeEntryProbes = 0
const waitingEntryProbes: (() => void)[] = []

function releaseEntrySlot(): void {
  activeEntryProbes--
  waitingEntryProbes.shift()?.()
}

async function takeEntrySlot(): Promise<void> {
  if (activeEntryProbes < ENTRY_PROBE_CONCURRENCY) {
    activeEntryProbes++
    return
  }
  await new Promise<void>((resolve) => waitingEntryProbes.push(resolve))
  activeEntryProbes++
}

/**
 * Full probe of one playlist row, so it can show its own thumbnail, sizes and
 * quality list rather than inheriting the batch's.
 */
export async function probeEntry(url: string, ctx: YtdlpContext): Promise<VideoInfo> {
  const safeUrl = validateUrl(url)

  const cached = entryCache.get(safeUrl)
  if (cached && Date.now() - cached.at < ENTRY_CACHE_TTL_MS) return cached.info

  await takeEntrySlot()
  try {
    // Re-checked: a call that queued behind the slot may have been waiting on
    // the very probe that just filled this in.
    const fresh = entryCache.get(safeUrl)
    if (fresh && Date.now() - fresh.at < ENTRY_CACHE_TTL_MS) return fresh.info

    const info = await runEntryProbe(safeUrl, ctx)
    entryCache.set(safeUrl, { at: Date.now(), info })
    return info
  } finally {
    releaseEntrySlot()
  }
}

function cleanProbeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  const line = raw
    .split('\n')
    .find((l) => l.includes('ERROR:'))
    ?.replace(/^ERROR:\s*/, '')
    .replace(/^\[[^\]]+\]\s*[\w-]+:\s*/, '')

  const message = (line ?? raw).trim()

  if (/Unsupported URL/i.test(message)) return 'That site is not supported.'
  if (/Sign in to confirm|not a bot/i.test(message)) return 'This video requires sign-in.'
  if (/Private video/i.test(message)) return 'This video is private.'
  if (/Video unavailable/i.test(message)) return 'Video unavailable.'
  if (/Timed out/i.test(message)) return 'Timed out reading that link.'
  if (/urlopen error|getaddrinfo|Temporary failure/i.test(message)) {
    return 'Network error — check your connection.'
  }

  return message.slice(0, 200) || 'Could not read that link.'
}
