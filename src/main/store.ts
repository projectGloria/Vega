import { randomUUID } from 'node:crypto'
import { readFile, writeFile, rename, mkdir, access, constants, readdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type {
  Category,
  ClipboardEntry,
  HistoryEntry,
  QueueItem,
  Settings
} from '@shared/types'
import { getPaths } from './bootstrap/paths'

/**
 * Small JSON-file store. Writes go through a temp file + rename so a crash
 * mid-write cannot leave an unparseable file that bricks startup.
 */
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = path + '.tmp'
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await rename(tmp, path)
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return null
  }
}

export function defaultSettings(): Settings {
  return {
    downloadDir: getPaths().defaultDownloadDir,
    outputTemplate: '%(title)s [%(id)s].%(ext)s',
    concurrency: 3,
    defaultQuality: 'best',
    audioCodec: 'mp3',
    subtitleLangs: ['en'],
    embedSubs: false,
    embedThumbnail: true,
    embedMetadata: true,
    sponsorblock: false,
    autoUpdateYtdlp: true,
    lastYtdlpUpdateCheck: 0,
    accent: '#38bdf8',
    autoProbeOnPaste: true,
    watchClipboard: true,
    closeToTray: true,
    cookies: null,
    categories: [],
    defaultCategoryId: null
  }
}

/** Characters NTFS rejects outright. Spaces and hyphens are legal and kept. */
const ILLEGAL_PATH_CHARS = /[<>:"/\\|?*]/g
const RESERVED_DEVICE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/**
 * Turns a category's display name into a subfolder name Windows will accept.
 * Reserved device names (CON, PRN, ...) are real and would fail at mkdir, and
 * a trailing dot or space is silently dropped by the OS — which would make the
 * folder we create and the folder we look for disagree.
 */
export function toFolderName(name: string): string {
  // Control characters are filtered by codepoint: putting them in a regex
  // literal invites exactly the kind of source corruption this avoids.
  const printable = Array.from(name.trim())
    .filter((ch) => (ch.codePointAt(0) ?? 0) >= 32)
    .join('')

  const cleaned = printable
    .replace(ILLEGAL_PATH_CHARS, '')
    .replace(/\s+/g, ' ')
    .replace(/[.\s]+$/, '')
    .slice(0, 60)
    .trim()

  if (!cleaned) return 'Untitled'
  if (RESERVED_DEVICE_NAMES.test(cleaned)) return cleaned + '_'
  return cleaned
}

let settings: Settings | null = null

function sanitizeCategories(input: unknown): Category[] {
  if (!Array.isArray(input)) return []

  const seen = new Set<string>()
  const result: Category[] = []

  for (const raw of input) {
    const candidate = raw as Partial<Category>
    const name = typeof candidate?.name === 'string' ? candidate.name.trim() : ''
    if (!name || seen.has(name.toLowerCase())) continue
    seen.add(name.toLowerCase())

    result.push({
      id: typeof candidate.id === 'string' && candidate.id ? candidate.id : randomUUID(),
      name: name.slice(0, 60),
      folder:
        typeof candidate.folder === 'string' && candidate.folder
          ? toFolderName(candidate.folder)
          : toFolderName(name)
    })
  }

  return result
}

/** Clamps user-supplied values so a hand-edited settings file cannot break the app. */
function sanitize(input: Partial<Settings>, base: Settings): Settings {
  const merged = { ...base, ...input }
  const categories = sanitizeCategories(merged.categories)

  return {
    ...merged,
    concurrency: Math.min(8, Math.max(1, Math.round(merged.concurrency) || 3)),
    outputTemplate: merged.outputTemplate?.trim() || base.outputTemplate,
    downloadDir: merged.downloadDir?.trim() || base.downloadDir,
    subtitleLangs: Array.isArray(merged.subtitleLangs) ? merged.subtitleLangs : ['en'],
    categories,
    // A default pointing at a deleted category would silently file downloads nowhere.
    defaultCategoryId: categories.some((c) => c.id === merged.defaultCategoryId)
      ? merged.defaultCategoryId
      : null,
    cookies: merged.cookies ?? null
  }
}

export async function loadSettings(): Promise<Settings> {
  const base = defaultSettings()
  const stored = await readJson<Partial<Settings>>(getPaths().settingsFile)

  if (stored) {
    settings = sanitize(stored, base)

    // Migrate the file forward when a new release adds settings, so the on-disk
    // shape matches what the app actually uses and stays hand-editable.
    const missing = Object.keys(base).filter((key) => !(key in stored))
    if (missing.length > 0) {
      await writeJsonAtomic(getPaths().settingsFile, settings).catch(() => {})
    }

    return settings
  }

  // Seed the file on first run so the defaults are visible and hand-editable
  // rather than existing only in memory.
  settings = base
  await writeJsonAtomic(getPaths().settingsFile, settings).catch(() => {})
  return settings
}

export function getSettings(): Settings {
  if (!settings) settings = defaultSettings()
  return settings
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  settings = sanitize(patch, getSettings())
  await writeJsonAtomic(getPaths().settingsFile, settings)
  return settings
}

export function findCategory(id: string | null | undefined): Category | null {
  if (!id) return null
  return getSettings().categories.find((c) => c.id === id) ?? null
}

export async function createCategory(name: string): Promise<Settings> {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Category name cannot be empty.')

  const current = getSettings()
  if (current.categories.some((c) => c.name.toLowerCase() === trimmed.toLowerCase())) {
    throw new Error('A category called "' + trimmed + '" already exists.')
  }

  const category: Category = {
    id: randomUUID(),
    name: trimmed.slice(0, 60),
    folder: toFolderName(trimmed)
  }

  return updateSettings({ categories: [...current.categories, category] })
}

/**
 * Removes the category from settings only. The folder and the files inside it
 * are left alone — deleting someone's downloads because they tidied a label
 * would be indefensible.
 */
export async function removeCategory(id: string): Promise<Settings> {
  const current = getSettings()
  return updateSettings({
    categories: current.categories.filter((c) => c.id !== id)
  })
}

export async function isWritable(dir: string): Promise<boolean> {
  try {
    await mkdir(dir, { recursive: true })
    await access(dir, constants.W_OK)
    return true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ */
/* Queue persistence                                                   */
/* ------------------------------------------------------------------ */

/**
 * Persisting the queue means a crash or restart does not lose a 40-item
 * playlist. In-flight items come back as `paused` rather than `downloading`,
 * since their child processes died with the app.
 */
export async function saveQueue(items: QueueItem[]): Promise<void> {
  await writeJsonAtomic(getPaths().queueFile, items)
}

export async function loadQueue(): Promise<QueueItem[]> {
  const stored = await readJson<QueueItem[]>(getPaths().queueFile)
  if (!Array.isArray(stored)) return []

  return stored.map((item) => {
    // Fields added in later releases are absent from an older queue.json.
    const base = { ...item, categoryId: item.categoryId ?? null, uploader: item.uploader ?? null }
    if (base.status === 'downloading' || base.status === 'merging' || base.status === 'probing') {
      return { ...base, status: 'paused' as const, speed: null, eta: null }
    }
    return base
  })
}

/* ------------------------------------------------------------------ */
/* History                                                             */
/* ------------------------------------------------------------------ */

const MAX_HISTORY = 1000

let history: HistoryEntry[] | null = null

export async function loadHistory(): Promise<HistoryEntry[]> {
  const stored = await readJson<HistoryEntry[]>(getPaths().historyFile)
  history = Array.isArray(stored) ? stored : []

  const repaired = await repairMojibakePaths(history)
  if (repaired) await persistHistory()

  return history
}

/**
 * One-time repair for paths recorded before yt-dlp was pinned to UTF-8 output.
 *
 * Those entries stored a name that had been through the Windows ANSI codepage
 * and back, so an accented title turned into replacement characters and history
 * reported a file that was sitting on disk the whole time as missing.
 *
 * The corruption is deterministic, so rather than guessing at the original name
 * we re-apply it to each real filename in the folder and look for the one that
 * comes out matching what we stored. A rename is accepted only on a single
 * unambiguous match — pointing an entry at the wrong video would be worse than
 * leaving it broken.
 */
async function repairMojibakePaths(entries: HistoryEntry[]): Promise<boolean> {
  let changed = false

  for (const entry of entries) {
    const path = entry.outputPath
    // U+FFFD is the tell; a path without one was never mangled this way.
    if (!path || !path.includes('�')) continue
    if (await exists(path)) continue

    const folder = dirname(path)
    const target = basename(path)

    const names = await readdir(folder).catch(() => [] as string[])
    const matches = names.filter((name) => mangleLikeAnsi(name) === target)

    if (matches.length === 1) {
      entry.outputPath = join(folder, matches[0])
      changed = true
    }
  }

  return changed
}

/**
 * Reproduces the old corruption: encode to Windows-1252 dropping anything the
 * codepage cannot represent, then decode those bytes as UTF-8.
 */
function mangleLikeAnsi(name: string): string {
  const bytes: number[] = []

  for (const char of name) {
    const code = char.codePointAt(0) as number
    const special = CP1252.get(char)

    if (code < 0x80) bytes.push(code)
    else if (special !== undefined) bytes.push(special)
    else if (code <= 0xff && code >= 0xa0) bytes.push(code)
    // Anything else — İ, Ş, ı, ğ — has no Windows-1252 byte and simply vanished.
  }

  return Buffer.from(bytes).toString('utf8')
}

/** Only the Windows-1252 codepoints that differ from Latin-1 need a mapping. */
const CP1252 = new Map<string, number>([
  ['€', 0x80], ['‚', 0x82], ['ƒ', 0x83], ['„', 0x84],
  ['…', 0x85], ['†', 0x86], ['‡', 0x87], ['ˆ', 0x88],
  ['‰', 0x89], ['Š', 0x8a], ['‹', 0x8b], ['Œ', 0x8c],
  ['Ž', 0x8e], ['‘', 0x91], ['’', 0x92], ['“', 0x93],
  ['”', 0x94], ['•', 0x95], ['–', 0x96], ['—', 0x97],
  ['˜', 0x98], ['™', 0x99], ['š', 0x9a], ['›', 0x9b],
  ['œ', 0x9c], ['ž', 0x9e], ['Ÿ', 0x9f]
])

async function exists(path: string): Promise<boolean> {
  return access(path, constants.F_OK).then(
    () => true,
    () => false
  )
}

export function getHistory(): HistoryEntry[] {
  return history ?? []
}

async function persistHistory(): Promise<void> {
  await writeJsonAtomic(getPaths().historyFile, history ?? []).catch(() => {})
}

/**
 * History outlives the file: entries are kept even after the video is deleted
 * or moved elsewhere, which is the whole point of having it.
 */
export async function addHistoryEntry(entry: HistoryEntry): Promise<HistoryEntry[]> {
  const current = history ?? (await loadHistory())

  // Re-downloading something replaces its old row rather than duplicating it.
  const deduped = current.filter((e) => !(e.url === entry.url && e.selectionLabel === entry.selectionLabel))
  history = [entry, ...deduped].slice(0, MAX_HISTORY)

  await persistHistory()
  return history
}

export async function removeHistoryEntry(id: string): Promise<HistoryEntry[]> {
  history = (history ?? []).filter((e) => e.id !== id)
  await persistHistory()
  return history
}

export async function clearHistory(): Promise<HistoryEntry[]> {
  history = []
  await persistHistory()
  return history
}

/* ------------------------------------------------------------------ */
/* Clipboard inbox                                                     */
/* ------------------------------------------------------------------ */

const MAX_CLIPBOARD_ENTRIES = 200

let clipboardEntries: ClipboardEntry[] | null = null

export async function loadClipboardEntries(): Promise<ClipboardEntry[]> {
  const stored = await readJson<ClipboardEntry[]>(getPaths().clipboardFile)
  clipboardEntries = Array.isArray(stored) ? stored : []

  // A probe that was in flight when the app closed never finished.
  clipboardEntries = clipboardEntries.map((e) =>
    e.status === 'pending' ? { ...e, status: 'error' as const, error: 'Interrupted' } : e
  )
  return clipboardEntries
}

export function getClipboardEntries(): ClipboardEntry[] {
  return clipboardEntries ?? []
}

export async function saveClipboardEntries(entries: ClipboardEntry[]): Promise<void> {
  clipboardEntries = entries.slice(0, MAX_CLIPBOARD_ENTRIES)
  await writeJsonAtomic(getPaths().clipboardFile, clipboardEntries).catch(() => {})
}
