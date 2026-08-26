/**
 * yt-dlp's human-readable progress bar is not a stable interface — it reflows,
 * uses carriage returns, and changes between releases. Instead we ask yt-dlp to
 * print a machine-readable line via --progress-template and parse that.
 */

export const PROGRESS_PREFIX = 'DLPROG'
export const FILEPATH_PREFIX = 'DLFILE'

const FIELDS = [
  '%(progress.status)s',
  '%(progress.downloaded_bytes)s',
  '%(progress.total_bytes)s',
  '%(progress.total_bytes_estimate)s',
  '%(progress.speed)s',
  '%(progress.eta)s',
  '%(progress.fragment_index)s',
  '%(progress.fragment_count)s'
].join('|')

/** Args that turn on machine-readable progress output. */
export function progressTemplateArgs(): string[] {
  return [
    '--newline',
    '--no-color',
    '--progress',
    '--progress-template',
    'download:' + PROGRESS_PREFIX + '|' + FIELDS,
    // Emits the final path once the file has been moved into place.
    '--print',
    'after_move:' + FILEPATH_PREFIX + '|%(filepath)s',
    // `--print` implies `--quiet`, which silenced every other console line —
    // and three things quietly depended on those lines: the "Processing"
    // status comes from seeing `[Merger]`/`[ExtractAudio]`, the per-item
    // details panel is that output, and parseDestinationLine is the fallback
    // for when after_move does not fire. A 17-second mp3 transcode still read
    // as "Downloading, 100%" and the log panel was always empty. This must
    // stay after --print: it is what puts the output back.
    '--no-quiet'
  ]
}

export interface ProgressEvent {
  status: string
  downloadedBytes: number | null
  totalBytes: number | null
  speed: number | null
  eta: number | null
  percent: number | null
  fragmentIndex: number | null
  fragmentCount: number | null
}

/** yt-dlp renders unknown values as "NA". */
function num(raw: string | undefined): number | null {
  if (!raw || raw === 'NA' || raw === 'None') return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

export function parseProgressLine(line: string): ProgressEvent | null {
  if (!line.startsWith(PROGRESS_PREFIX + '|')) return null

  const parts = line.split('|')
  const status = parts[1] ?? 'downloading'
  const downloadedBytes = num(parts[2])
  const totalBytes = num(parts[3]) ?? num(parts[4])
  const fragmentIndex = num(parts[7])
  const fragmentCount = num(parts[8])

  let percent: number | null = null
  if (downloadedBytes !== null && totalBytes) {
    percent = Math.min(100, (downloadedBytes / totalBytes) * 100)
  } else if (fragmentIndex !== null && fragmentCount) {
    // Fragmented (HLS/DASH) downloads often have no byte total; fragments are
    // the only meaningful progress signal there.
    percent = Math.min(100, (fragmentIndex / fragmentCount) * 100)
  }
  if (status === 'finished') percent = 100

  return {
    status,
    downloadedBytes,
    totalBytes,
    speed: num(parts[5]),
    eta: num(parts[6]),
    percent,
    fragmentIndex,
    fragmentCount
  }
}

export function parseFilepathLine(line: string): string | null {
  if (!line.startsWith(FILEPATH_PREFIX + '|')) return null
  const path = line.slice(FILEPATH_PREFIX.length + 1).trim()
  return path.length > 0 && path !== 'NA' ? path : null
}

/**
 * Fallback path capture.
 *
 * `after_move` is the authoritative source, but it does not fire on every route
 * through yt-dlp (an already-downloaded file, some post-processor paths). These
 * lines give a usable path in those cases, so history never ends up with a
 * completed download it cannot point at.
 */
export function parseDestinationLine(line: string): string | null {
  const merger = line.match(/\[Merger\] Merging formats into "(.+)"$/)
  if (merger) return merger[1]

  const extractAudio = line.match(/\[ExtractAudio\] Destination: (.+)$/)
  if (extractAudio) return extractAudio[1]

  const destination = line.match(/^\[download\] Destination: (.+)$/)
  if (destination) return destination[1]

  // "has already been downloaded" — the file exists from a previous run.
  const already = line.match(/^\[download\] (.+) has already been downloaded$/)
  if (already) return already[1]

  return null
}

/** Post-processing stages that should show as "merging" rather than a stalled bar. */
const POSTPROCESS_MARKERS = [
  '[Merger]',
  '[ExtractAudio]',
  '[VideoConvertor]',
  '[EmbedSubtitle]',
  '[Metadata]',
  '[ThumbnailsConvertor]',
  '[EmbedThumbnail]',
  '[SponsorBlock]',
  '[ModifyChapters]',
  '[FixupM3u8]',
  '[FixupM4a]'
]

export function isPostProcessLine(line: string): boolean {
  return POSTPROCESS_MARKERS.some((marker) => line.includes(marker))
}

/**
 * Turns yt-dlp's raw stderr into something a person can act on. The full log is
 * always kept; this is only for the one-line summary on the queue row.
 */
export function summarizeError(logLines: string[]): string {
  const errors = logLines.filter((l) => l.includes('ERROR:'))
  const last = errors[errors.length - 1] ?? logLines[logLines.length - 1] ?? 'Download failed'

  const cleaned = last
    .replace(/^ERROR:\s*/, '')
    .replace(/^\[[^\]]+\]\s*[\w-]+:\s*/, '')
    .trim()

  if (/Sign in to confirm|not a bot/i.test(cleaned)) {
    return 'This video requires sign-in. Try again later or use a different source.'
  }
  if (/Private video/i.test(cleaned)) return 'This video is private.'
  if (/Video unavailable/i.test(cleaned)) return 'Video unavailable.'
  if (/members-only|paid|purchase/i.test(cleaned)) return 'This video requires a paid membership.'
  if (/Requested format is not available/i.test(cleaned)) {
    return 'That format is no longer available. Try another quality.'
  }
  if (/Unable to download.*HTTP Error 4\d\d/i.test(cleaned)) {
    return 'The server refused the download (' + (cleaned.match(/HTTP Error \d+/)?.[0] ?? '4xx') + ').'
  }
  if (/urlopen error|timed out|Temporary failure|getaddrinfo/i.test(cleaned)) {
    return 'Network error — check your connection.'
  }
  if (/No space left/i.test(cleaned)) return 'Not enough disk space.'

  return cleaned.slice(0, 200) || 'Download failed'
}

/** Errors worth an automatic retry; everything else needs the user. */
export function isRetryableError(message: string): boolean {
  return /Network error|timed out|urlopen|Temporary failure|getaddrinfo|HTTP Error 5\d\d|Connection reset|refused the download \(HTTP Error 5/i.test(
    message
  )
}
