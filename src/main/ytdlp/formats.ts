import { join } from 'node:path'
import type { DownloadRequest, MediaFormat, VideoInfo } from '@shared/types'
import { progressTemplateArgs } from './progress'

export interface YtdlpContext {
  ytdlpExe: string
  ffmpegDir: string
  cacheDir: string
  outputDir: string
  outputTemplate: string
  /** Sanitized subfolder for the chosen category; null files into the root. */
  categoryFolder?: string | null
  /** Exported cookie jar, or null when none has been captured. */
  cookiesFile?: string | null
}

/**
 * Args applied to every invocation.
 *
 * --ignore-config matters: without it a stray %APPDATA%/yt-dlp/config on the
 * user's machine would silently change our output paths and formats.
 *
 * --encoding utf-8 is not cosmetic. With its stdout on a pipe, yt-dlp writes
 * text in the Windows ANSI codepage, so a title starting with Ö arrives as the
 * byte 0xD6 instead of UTF-8 — and the path it reports through `after_move`
 * decodes to garbage. The file on disk is named correctly; only our record of
 * it was wrong, which made history claim a perfectly good download had been
 * moved or deleted. yt-dlp ignores PYTHONIOENCODING and PYTHONUTF8 here, so
 * this flag is the only thing that actually fixes it.
 */
export function baseArgs(ctx: YtdlpContext): string[] {
  const cookies = ctx.cookiesFile ? ['--cookies', ctx.cookiesFile] : []

  return [
    ...cookies,
    '--ignore-config',
    '--no-color',
    '--encoding',
    'utf-8',
    '--cache-dir',
    ctx.cacheDir,
    '--ffmpeg-location',
    ctx.ffmpegDir
  ]
}

/** Builds the -f selector for a chosen quality/format/audio intent. */
export function formatSelector(selection: DownloadRequest['selection']): string[] {
  switch (selection.mode) {
    case 'best': {
      // No height cap and, deliberately, no --merge-output-format: forcing mp4
      // would make yt-dlp remux (or reject) the best VP9/AV1+Opus pairing that
      // many sites only offer in webm. Letting it pick the container is what
      // makes "best" actually best rather than "best that fits in an mp4".
      return ['-f', 'bv*+ba/b']
    }
    case 'quality': {
      const h = selection.height
      // Prefer separate streams (better quality caps) but fall back to a
      // pre-muxed file when the site offers nothing to merge.
      return [
        '-f',
        'bv*[height<=' + h + ']+ba/b[height<=' + h + ']/bv*+ba/b',
        '--merge-output-format',
        'mp4'
      ]
    }
    case 'format': {
      const id = selection.formatId
      return selection.needsAudio
        ? ['-f', id + '+ba/' + id, '--merge-output-format', 'mp4']
        : ['-f', id]
    }
    case 'audio': {
      const quality = selection.quality === 'best' ? '0' : selection.quality + 'K'
      return [
        '-f',
        'ba/b',
        '-x',
        '--audio-format',
        selection.codec,
        '--audio-quality',
        quality
      ]
    }
  }
}

/**
 * Full arg list for one download. The URL is passed last and always as its own
 * array element — never interpolated into a string — so a hostile URL cannot
 * become an extra flag or a shell token.
 */
export function buildDownloadArgs(req: DownloadRequest, ctx: YtdlpContext): string[] {
  // A category is just a subfolder; `categoryFolder` is already sanitized by
  // the store, so it can be joined without re-checking for traversal.
  const baseDir = req.outputDir ?? ctx.outputDir
  const outputDir = ctx.categoryFolder ? join(baseDir, ctx.categoryFolder) : baseDir

  const args = [
    ...baseArgs(ctx),
    ...progressTemplateArgs(),
    ...formatSelector(req.selection),
    '--no-playlist',
    '--continue',
    '--no-mtime',
    // Keeps names valid on NTFS without mangling non-ASCII titles.
    '--windows-filenames',
    '--paths',
    'home:' + outputDir,
    '--paths',
    'temp:' + outputDir,
    '-o',
    ctx.outputTemplate,
    // Retries inside yt-dlp handle transient blips; the queue handles the rest.
    '--retries',
    '5',
    '--fragment-retries',
    '5'
  ]

  if (req.embedSubs && req.subtitleLangs && req.subtitleLangs.length > 0) {
    args.push('--embed-subs', '--sub-langs', req.subtitleLangs.join(','))
  }
  if (req.embedThumbnail) args.push('--embed-thumbnail')
  if (req.embedMetadata) args.push('--embed-metadata')
  if (req.sponsorblock) args.push('--sponsorblock-remove', 'default')

  args.push('--', req.url)
  return args
}

/* ------------------------------------------------------------------ */
/* Format normalization                                                */
/* ------------------------------------------------------------------ */

function shortCodec(codec: string | null): string {
  if (!codec || codec === 'none') return ''
  if (codec.startsWith('avc1')) return 'H.264'
  if (codec.startsWith('av01')) return 'AV1'
  if (codec.startsWith('vp9') || codec.startsWith('vp09')) return 'VP9'
  if (codec.startsWith('hev1') || codec.startsWith('hvc1')) return 'HEVC'
  if (codec.startsWith('mp4a')) return 'AAC'
  return codec.split('.')[0]
}

interface RawFormat {
  format_id?: string
  ext?: string
  height?: number | null
  width?: number | null
  fps?: number | null
  vcodec?: string | null
  acodec?: string | null
  filesize?: number | null
  filesize_approx?: number | null
  tbr?: number | null
  abr?: number | null
  format_note?: string | null
  protocol?: string | null
}

/**
 * Maps yt-dlp's raw format objects onto the shape the UI renders.
 *
 * `duration` matters: plenty of sites report neither `filesize` nor
 * `filesize_approx` for DASH streams but always give a bitrate. Deriving the
 * size from bitrate x duration is what stops the UI saying "size unknown" on
 * formats whose size is perfectly predictable.
 */
export function normalizeFormats(raw: RawFormat[], duration: number | null = null): MediaFormat[] {
  const formats: MediaFormat[] = []

  for (const f of raw) {
    if (!f.format_id) continue
    // Storyboard/thumbnail "formats" are not downloadable media.
    if (f.ext === 'mhtml' || f.protocol === 'mhtml') continue

    const hasVideo = !!f.vcodec && f.vcodec !== 'none'
    const hasAudio = !!f.acodec && f.acodec !== 'none'
    if (!hasVideo && !hasAudio) continue

    const kind: MediaFormat['kind'] = hasVideo && hasAudio ? 'combined' : hasVideo ? 'video' : 'audio'

    const reported = f.filesize ?? f.filesize_approx ?? null
    // tbr is in kbit/s; bytes = kbit/s * 1000 / 8 * seconds.
    const bitrate = f.tbr ?? (!hasVideo ? f.abr : null) ?? null
    const derived =
      reported === null && bitrate && duration ? Math.round((bitrate * 1000 * duration) / 8) : null

    const filesize = reported ?? derived

    let label: string
    if (hasVideo) {
      const res = f.height ? f.height + 'p' : (f.format_note ?? 'video')
      const fps = f.fps && f.fps >= 50 ? String(Math.round(f.fps)) : ''
      const codec = shortCodec(f.vcodec ?? null)
      label = res + fps + (codec ? ' · ' + codec : '')
    } else {
      const codec = shortCodec(f.acodec ?? null) || (f.ext ?? 'audio')
      const bitrate = f.abr ? ' ' + Math.round(f.abr) + 'k' : ''
      label = codec + bitrate
    }

    formats.push({
      formatId: f.format_id,
      ext: f.ext ?? '',
      height: f.height ?? null,
      width: f.width ?? null,
      fps: f.fps ?? null,
      vcodec: hasVideo ? (f.vcodec ?? null) : null,
      acodec: hasAudio ? (f.acodec ?? null) : null,
      filesize,
      // Anything that is not an exact `filesize` is an estimate, including the
      // bitrate-derived figure.
      filesizeIsEstimate: f.filesize == null && filesize !== null,
      tbr: f.tbr ?? null,
      label,
      kind
    })
  }

  // Best first: by height, then bitrate.
  formats.sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.tbr ?? 0) - (a.tbr ?? 0))
  return formats
}

/** The handful of heights offered as one-click chips. */
export function qualityChips(formats: MediaFormat[]): number[] {
  const heights = new Set<number>()
  for (const f of formats) {
    if (f.kind !== 'audio' && f.height) heights.add(f.height)
  }
  return [...heights].sort((a, b) => b - a).slice(0, 6)
}

/**
 * Estimated size for a quality choice: the best video stream at or below that
 * height, plus the best audio stream, since those are what get merged.
 */
/** Size of the best video + best audio, matching what `mode: 'best'` downloads. */
export function estimateBestSize(info: VideoInfo): number | null {
  const video = info.formats
    .filter((f) => f.kind !== 'audio')
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.tbr ?? 0) - (a.tbr ?? 0))[0]
  if (!video?.filesize) return null
  if (video.kind === 'combined') return video.filesize

  const audio = info.formats
    .filter((f) => f.kind === 'audio' && f.filesize)
    .sort((a, b) => (b.tbr ?? 0) - (a.tbr ?? 0))[0]

  return video.filesize + (audio?.filesize ?? 0)
}

export function estimateSizeForHeight(info: VideoInfo, height: number): number | null {
  const video = info.formats
    .filter((f) => f.kind !== 'audio' && f.height !== null && f.height <= height)
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.tbr ?? 0) - (a.tbr ?? 0))[0]
  if (!video?.filesize) return null

  if (video.kind === 'combined') return video.filesize

  const audio = info.formats
    .filter((f) => f.kind === 'audio' && f.filesize)
    .sort((a, b) => (b.tbr ?? 0) - (a.tbr ?? 0))[0]

  return video.filesize + (audio?.filesize ?? 0)
}
