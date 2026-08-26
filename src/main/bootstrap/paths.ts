import { app } from 'electron'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

/**
 * Every path the app writes to lives under userData (%APPDATA%/<app>) so that
 * wiping that one folder fully resets the app.
 */
export interface AppPaths {
  root: string
  bin: string
  cache: string
  logs: string
  /** yt-dlp's own extractor cache, kept inside our tree via --cache-dir */
  ytdlpCache: string
  settingsFile: string
  queueFile: string
  /** Completed downloads, kept even after the files are moved or deleted. */
  historyFile: string
  /** Links captured from the clipboard while running in the background. */
  clipboardFile: string
  /** Netscape cookie jar exported from a browser, passed to yt-dlp as --cookies. */
  cookiesFile: string
  ytdlpExe: string
  ffmpegExe: string
  ffprobeExe: string
  defaultDownloadDir: string
}

let cached: AppPaths | null = null

export function getPaths(): AppPaths {
  if (cached) return cached

  const root = app.getPath('userData')
  const bin = join(root, 'bin')

  cached = {
    root,
    bin,
    cache: join(root, 'cache'),
    logs: join(root, 'logs'),
    ytdlpCache: join(root, 'cache', 'yt-dlp'),
    settingsFile: join(root, 'settings.json'),
    queueFile: join(root, 'queue.json'),
    historyFile: join(root, 'history.json'),
    clipboardFile: join(root, 'clipboard.json'),
    cookiesFile: join(root, 'cookies.txt'),
    ytdlpExe: join(bin, 'yt-dlp.exe'),
    ffmpegExe: join(bin, 'ffmpeg.exe'),
    ffprobeExe: join(bin, 'ffprobe.exe'),
    defaultDownloadDir: join(app.getPath('downloads'), 'VideoDownloader')
  }
  return cached
}

/** Creates the writable tree. Safe to call repeatedly. */
export function ensureDirs(): AppPaths {
  const p = getPaths()
  for (const dir of [p.root, p.bin, p.cache, p.logs, p.ytdlpCache]) {
    mkdirSync(dir, { recursive: true })
  }
  return p
}
