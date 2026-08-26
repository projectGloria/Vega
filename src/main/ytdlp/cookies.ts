import { basename, dirname, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import { readFile, writeFile, rm, access, constants, stat } from 'node:fs/promises'
import type { CookieBrowser, CookieStatus, BrowserPresence } from '@shared/types'
import { getPaths } from '../bootstrap/paths'
import { runCapture } from './runner'

/**
 * Cookies let yt-dlp act as a signed-in browser, which is what gets past
 * YouTube's "sign in to confirm you're not a bot" wall on some videos.
 *
 * We export them once into a Netscape cookie jar of our own rather than
 * reading the browser on every download: yt-dlp's browser reader has to copy
 * and decrypt the profile database each time, which is slow, fails outright
 * while the browser is running, and would repeat that fragility on every item
 * in the queue.
 */

interface BrowserSpec {
  id: CookieBrowser
  label: string
  /** Process image name, used to tell the user which window to close. */
  process: string
  /** Profile roots; the first one that exists is the one we read. */
  roots: (env: Env) => string[]
  /** Picks which profile inside a root to read. */
  resolve: (root: string) => Promise<ResolvedProfile | null>
}

interface ResolvedProfile {
  /** The folder cookies actually come from. Surfaced in the UI to be checked. */
  dir: string
  /**
   * Suffix for --cookies-from-browser, as in firefox:<name>. Null lets yt-dlp
   * choose, which is right for browsers keeping one profile where it expects.
   */
  spec: string | null
  /** Display name, where the browser keeps more than one profile. */
  name: string | null
}

interface Env {
  local: string
  roaming: string
  home: string
}

/**
 * The order here is the order shown in settings. Chromium-based browsers come
 * first because they are the common case, Firefox last because it is the one
 * that reliably works — see `explainFailure`.
 */
const BROWSERS: BrowserSpec[] = [
  {
    id: 'brave',
    label: 'Brave',
    process: 'brave.exe',
    roots: (e) => [join(e.local, 'BraveSoftware', 'Brave-Browser', 'User Data')],
    resolve: resolveChromium
  },
  {
    id: 'chrome',
    label: 'Chrome',
    process: 'chrome.exe',
    roots: (e) => [join(e.local, 'Google', 'Chrome', 'User Data')],
    resolve: resolveChromium
  },
  {
    id: 'edge',
    label: 'Edge',
    process: 'msedge.exe',
    roots: (e) => [join(e.local, 'Microsoft', 'Edge', 'User Data')],
    resolve: resolveChromium
  },
  {
    id: 'opera',
    label: 'Opera',
    process: 'opera.exe',
    roots: (e) => [
      join(e.roaming, 'Opera Software', 'Opera Stable'),
      join(e.roaming, 'Opera Software', 'Opera GX Stable')
    ],
    // Opera keeps its profile in the root itself rather than a Default subfolder.
    resolve: async (root) => ({ dir: root, spec: null, name: null })
  },
  {
    id: 'vivaldi',
    label: 'Vivaldi',
    process: 'vivaldi.exe',
    roots: (e) => [join(e.local, 'Vivaldi', 'User Data')],
    resolve: resolveChromium
  },
  {
    id: 'firefox',
    label: 'Firefox',
    process: 'firefox.exe',
    roots: (e) => [join(e.roaming, 'Mozilla', 'Firefox', 'Profiles')],
    resolve: resolveFirefox
  }
]

const BROWSER_IDS = new Set<string>(BROWSERS.map((b) => b.id))

/** Narrows an untrusted IPC value to a browser we actually support. */
export function asCookieBrowser(value: unknown): CookieBrowser {
  if (typeof value !== 'string' || !BROWSER_IDS.has(value)) {
    throw new Error('Unsupported browser')
  }
  return value as CookieBrowser
}

function env(): Env {
  const home = homedir()
  return {
    local: process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'),
    roaming: process.env.APPDATA ?? join(home, 'AppData', 'Roaming'),
    home
  }
}

async function exists(path: string): Promise<boolean> {
  return access(path, constants.F_OK).then(
    () => true,
    () => false
  )
}

async function mtime(path: string): Promise<number> {
  return stat(path).then(
    (s) => s.mtimeMs,
    () => 0
  )
}

/* ------------------------------------------------------------------ */
/* Profile resolution                                                  */
/* ------------------------------------------------------------------ */

/** Chromium keeps the primary profile in a fixed subfolder; so does yt-dlp. */
async function resolveChromium(root: string): Promise<ResolvedProfile | null> {
  const preferred = join(root, 'Default')
  if (await exists(preferred)) return { dir: preferred, spec: null, name: 'Default' }
  return { dir: root, spec: null, name: null }
}

/**
 * Firefox is the one browser where letting yt-dlp choose is actively wrong.
 *
 * Release, Developer Edition and Nightly all keep profiles side by side under
 * the same Profiles folder, and yt-dlp just takes whichever `cookies.sqlite`
 * was touched most recently. That silently reads Developer Edition — a profile
 * that is usually signed into nothing — and the export "succeeds" with cookies
 * that do not work. So the release profile is picked explicitly here, and the
 * folder is reported to the UI so the choice can be checked rather than
 * trusted.
 */
async function resolveFirefox(root: string): Promise<ResolvedProfile | null> {
  // profiles.ini sits one level above Profiles/ and is the authoritative list.
  const iniPath = join(dirname(root), 'profiles.ini')
  const ini = await readFile(iniPath, 'utf8').catch(() => null)

  const candidates: { dir: string; name: string; isDefault: boolean }[] = []

  if (ini) {
    for (const section of parseIni(ini)) {
      // [Profile0], [Profile1]… only. [Install…] points at these, and
      // [BackgroundTasksProfiles] are throwaway profiles with no cookies.
      if (!/^Profile\d+$/i.test(section.name)) continue

      const rel = section.values.Path
      if (!rel) continue

      const normalized = rel.replace(/\//g, '\\')
      const dir =
        section.values.IsRelative === '0' && isAbsolute(normalized)
          ? normalized
          : join(dirname(root), normalized)

      candidates.push({
        dir,
        name: section.values.Name ?? basename(dir),
        isDefault: section.values.Default === '1'
      })
    }
  }

  // A profile is only usable if it actually holds a cookie database.
  const usable: { dir: string; name: string; isDefault: boolean; touched: number }[] = []
  for (const c of candidates) {
    const db = join(c.dir, 'cookies.sqlite')
    if (await exists(db)) usable.push({ ...c, touched: await mtime(db) })
  }

  // Anything but the release build. Developer Edition and Nightly are separate
  // installs with separate logins, and are not what "Firefox" means here.
  const release = usable.filter((c) => !/dev-edition|aurora|nightly/i.test(c.dir + ' ' + c.name))
  const pool = release.length > 0 ? release : usable
  if (pool.length === 0) return null

  const chosen =
    pool.find((c) => /default-release/i.test(c.dir)) ??
    pool.find((c) => c.isDefault) ??
    pool.sort((a, b) => b.touched - a.touched)[0]

  // yt-dlp mangles absolute Windows paths in this option (the backslashes are
  // eaten), but it resolves a bare profile folder name against Profiles/. That
  // only holds for profiles that actually live there; anywhere else, fall back
  // to letting yt-dlp choose rather than passing something it will mis-parse.
  const insideRoot = join(root, basename(chosen.dir)) === chosen.dir

  return {
    dir: chosen.dir,
    spec: insideRoot ? basename(chosen.dir) : null,
    name: chosen.name
  }
}

interface IniSection {
  name: string
  values: Record<string, string>
}

function parseIni(text: string): IniSection[] {
  const sections: IniSection[] = []
  let current: IniSection | null = null

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith(';') || line.startsWith('#')) continue

    const header = line.match(/^\[(.+)\]$/)
    if (header) {
      current = { name: header[1], values: {} }
      sections.push(current)
      continue
    }

    if (!current) continue
    const eq = line.indexOf('=')
    if (eq > 0) current.values[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }

  return sections
}

/**
 * Which browsers are on this machine, and exactly which folder each one would
 * be read from. Every browser stays visible either way — hiding one would just
 * look like a missing feature — but the ones with no profile are shown as not
 * installed rather than offering a button that cannot work.
 */
export async function detectBrowsers(): Promise<BrowserPresence[]> {
  const e = env()

  return Promise.all(
    BROWSERS.map(async (spec) => {
      const profile = await resolveProfile(spec, e)
      return {
        id: spec.id,
        label: spec.label,
        installed: profile !== null,
        profileDir: profile?.dir ?? null,
        profileName: profile?.name ?? null
      }
    })
  )
}

async function resolveProfile(spec: BrowserSpec, e: Env): Promise<ResolvedProfile | null> {
  for (const root of spec.roots(e)) {
    if (!(await exists(root))) continue
    const profile = await spec.resolve(root)
    if (profile) return profile
  }
  return null
}

/* ------------------------------------------------------------------ */
/* Capture                                                             */
/* ------------------------------------------------------------------ */

/**
 * yt-dlp writes its cookie jar when a run finishes, and a run needs something
 * to work on. Handing it a stub info file gives it a complete extract cycle
 * that touches no network at all, so capturing cookies never depends on a site
 * being reachable — or leaks the fact that we are capturing to anyone.
 */
const STUB_INFO = JSON.stringify({
  id: 'cookie-export',
  title: 'cookie-export',
  ext: 'mp4',
  // A bare `url` makes the entry its own single format. Declaring an empty
  // `formats` list instead reads as a real extraction that turned up nothing,
  // and yt-dlp aborts with "No video formats found" before reaching the
  // cookies at all.
  url: 'https://localhost/none',
  webpage_url: 'https://localhost/none',
  extractor: 'generic',
  extractor_key: 'Generic'
})

export async function captureCookies(browser: CookieBrowser): Promise<CookieStatus> {
  const paths = getPaths()
  const spec = BROWSERS.find((b) => b.id === browser)
  if (!spec) throw new Error('Unsupported browser')

  const profile = await resolveProfile(spec, env())
  if (!profile) {
    throw new Error(spec.label + ' is not installed, or has no profile on this account.')
  }

  const stubFile = join(paths.cache, 'cookie-export.info.json')
  // Written next to the jar, not over it: a failed run must not wipe cookies
  // that are currently working.
  const stagingFile = paths.cookiesFile + '.new'

  await writeFile(stubFile, STUB_INFO, 'utf8')
  await rm(stagingFile, { force: true })

  const args = [
    '--ignore-config',
    '--no-color',
    '--encoding',
    'utf-8',
    '--cookies-from-browser',
    profile.spec ? browser + ':' + profile.spec : browser,
    '--cookies',
    stagingFile,
    '--load-info-json',
    stubFile,
    '--skip-download',
    '--simulate'
  ]

  // yt-dlp writes the cookie jar as it shuts down, whatever the run itself
  // did, so the jar is the real evidence and the exit code is only a reason to
  // report. Reading cookies can succeed while the throwaway extraction that
  // carries it fails for some unrelated reason, and that must not lose the jar.
  let failure: unknown = null
  try {
    await runCapture(paths.ytdlpExe, args, 60_000)
  } catch (err) {
    failure = err
  }

  const jar = (await exists(stagingFile)) ? await readFile(stagingFile, 'utf8') : null
  const status = jar ? summarize(jar, browser, profile) : null

  if (jar === null || status === null || status.cookieCount === 0) {
    await rm(stagingFile, { force: true })
    throw new Error(
      failure
        ? explainFailure(failure, browser)
        : 'No cookies found in ' + spec.label + '. Sign in to the site there first.'
    )
  }

  await writeFile(paths.cookiesFile, jar, 'utf8')
  await rm(stagingFile, { force: true })
  await rm(stubFile, { force: true })

  return status
}

export async function clearCookies(): Promise<void> {
  await rm(getPaths().cookiesFile, { force: true })
}

/* ------------------------------------------------------------------ */
/* Reading the jar                                                     */
/* ------------------------------------------------------------------ */

/**
 * Cookie names that only exist on a signed-in Google session. Their presence
 * is the difference between "we read the browser" and "we read a browser that
 * is actually logged in" — only the second one gets past the bot check, so the
 * UI reports them separately rather than calling any export a success.
 */
const YOUTUBE_AUTH_COOKIES = ['SID', '__Secure-3PSID', '__Secure-1PSID', 'SAPISID']

function summarize(jar: string, browser: CookieBrowser, profile: ResolvedProfile): CookieStatus {
  let cookieCount = 0
  let youtubeCount = 0
  let signedIn = false

  for (const line of jar.split('\n')) {
    const trimmed = line.trim()
    // '#HttpOnly_' is a real entry; every other '#' line is a comment.
    if (!trimmed || (trimmed.startsWith('#') && !trimmed.startsWith('#HttpOnly_'))) continue

    const fields = trimmed.split('\t')
    if (fields.length < 7) continue

    cookieCount++

    const domain = fields[0].replace('#HttpOnly_', '')
    if (!domain.includes('youtube.com') && !domain.includes('google.com')) continue

    youtubeCount++
    if (YOUTUBE_AUTH_COOKIES.includes(fields[5])) signedIn = true
  }

  return {
    browser,
    cookieCount,
    youtubeCount,
    signedIn,
    profileDir: profile.dir,
    profileName: profile.name,
    capturedAt: Date.now()
  }
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

function labelOf(browser: CookieBrowser): string {
  return BROWSERS.find((b) => b.id === browser)?.label ?? browser
}

function processOf(browser: CookieBrowser): string {
  return BROWSERS.find((b) => b.id === browser)?.process ?? browser
}

/**
 * yt-dlp's cookie errors are links to GitHub issues, which is useless in a
 * settings panel. Both common ones have a specific cause and a specific answer,
 * so they are translated into what the person actually has to do.
 */
function explainFailure(err: unknown, browser: CookieBrowser): string {
  const raw = err instanceof Error ? err.message : String(err)
  const name = labelOf(browser)

  // The profile database is locked while the browser holds it open.
  if (/could not copy .*cookie database/i.test(raw) || /database is locked/i.test(raw)) {
    return (
      'Close ' +
      name +
      ' completely and try again — it locks its cookie database while running. ' +
      'Check Task Manager for leftover ' +
      processOf(browser) +
      ' processes.'
    )
  }

  // App-Bound Encryption: Chromium ties the cookie key to the browser binary
  // itself, and nothing outside it can unwrap that key.
  if (/dpapi/i.test(raw) || /failed to decrypt/i.test(raw)) {
    return (
      name +
      ' encrypts its cookies so only ' +
      name +
      ' can read them (App-Bound Encryption), and yt-dlp cannot unwrap that. ' +
      'Firefox is not affected — signing in there and exporting from it is the reliable route.'
    )
  }

  if (/unsupported browser/i.test(raw)) {
    return 'This build of yt-dlp cannot read ' + name + '.'
  }

  if (/could not find .*cookies database|no such file|could not find/i.test(raw)) {
    return name + ' has no cookie database yet. Open it, sign in, then try again.'
  }

  const firstLine = raw.split('\n')[0].replace(/^ERROR:\s*/, '').trim()
  return firstLine || 'Could not read cookies from ' + name + '.'
}
