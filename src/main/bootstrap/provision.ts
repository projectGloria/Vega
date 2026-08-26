import { createWriteStream } from 'node:fs'
import { rename, rm, stat, chmod, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import yauzl from 'yauzl'

export interface DownloadProgress {
  receivedBytes: number
  totalBytes: number | null
  /** 0-100, null when the server sent no content-length */
  percent: number | null
}

const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'

/** Primary is a GitHub release (stable URL); the fallback is gyan.dev's build. */
const FFMPEG_URLS = [
  'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip',
  'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
]

/** Anything smaller than this is a redirect stub or an error page, not a binary. */
const MIN_YTDLP_BYTES = 2_000_000
const MIN_ZIP_BYTES = 10_000_000

/**
 * Streams a URL to disk through a `.part` file, then renames it into place.
 * A killed download therefore never leaves a truncated binary that later looks
 * "installed" and fails at spawn time.
 */
async function downloadToFile(
  url: string,
  destPath: string,
  minBytes: number,
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal
): Promise<void> {
  const partPath = destPath + '.part'
  await mkdir(dirname(destPath), { recursive: true })
  await rm(partPath, { force: true })

  const res = await fetch(url, {
    signal,
    redirect: 'follow',
    headers: { 'User-Agent': 'VideoDownloader' }
  })
  if (!res.ok || !res.body) {
    throw new Error('HTTP ' + res.status + ' ' + res.statusText + ' for ' + url)
  }

  const lengthHeader = res.headers.get('content-length')
  const totalBytes = lengthHeader ? Number(lengthHeader) : null
  let receivedBytes = 0

  const file = createWriteStream(partPath)
  const counter = new Writable({
    write(chunk: Buffer, _enc, cb) {
      receivedBytes += chunk.length
      onProgress({
        receivedBytes,
        totalBytes,
        percent: totalBytes ? Math.min(100, (receivedBytes / totalBytes) * 100) : null
      })
      file.write(chunk, () => cb())
    },
    final(cb) {
      file.end(() => cb())
    }
  })

  try {
    await pipeline(res.body as unknown as NodeJS.ReadableStream, counter)
  } catch (err) {
    await rm(partPath, { force: true }).catch(() => {})
    throw err
  }

  const written = await stat(partPath)
  if (written.size < minBytes) {
    await rm(partPath, { force: true })
    throw new Error(
      'Downloaded file is only ' +
        written.size +
        ' bytes, expected at least ' +
        minBytes +
        '. The source may have returned an error page.'
    )
  }

  await rm(destPath, { force: true })
  await rename(partPath, destPath)
}

export async function downloadYtdlp(
  destPath: string,
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal
): Promise<void> {
  await downloadToFile(YTDLP_URL, destPath, MIN_YTDLP_BYTES, onProgress, signal)
  await chmod(destPath, 0o755).catch(() => {})
}

/**
 * Pulls only ffmpeg.exe and ffprobe.exe out of a build archive; the rest of the
 * zip (shared libs, docs, ffplay) is discarded without ever hitting disk.
 */
function extractBinariesFromZip(
  zipPath: string,
  targets: Record<string, string>,
  onProgress: (extracted: number, total: number) => void
): Promise<void> {
  const wanted = Object.keys(targets)

  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (openErr, zipfile) => {
      if (openErr || !zipfile) {
        reject(openErr ?? new Error('Could not open archive'))
        return
      }

      const found = new Set<string>()
      let settled = false

      const fail = (err: Error) => {
        if (settled) return
        settled = true
        zipfile.close()
        reject(err)
      }

      zipfile.on('entry', (entry: yauzl.Entry) => {
        const name = entry.fileName.replace(/\\/g, '/').toLowerCase()
        const match = wanted.find((w) => name.endsWith('/bin/' + w))

        if (!match || found.has(match)) {
          zipfile.readEntry()
          return
        }

        zipfile.openReadStream(entry, (streamErr, readStream) => {
          if (streamErr || !readStream) {
            fail(streamErr ?? new Error('Read failed'))
            return
          }

          const dest = targets[match]
          const partPath = dest + '.part'

          const run = async () => {
            await mkdir(dirname(dest), { recursive: true })
            await pipeline(readStream, createWriteStream(partPath))
            await rm(dest, { force: true })
            await rename(partPath, dest)
            await chmod(dest, 0o755).catch(() => {})
          }

          run().then(
            () => {
              if (settled) return
              found.add(match)
              onProgress(found.size, wanted.length)
              if (found.size === wanted.length) {
                settled = true
                zipfile.close()
                resolve()
                return
              }
              zipfile.readEntry()
            },
            (err: Error) => {
              rm(partPath, { force: true }).catch(() => {})
              fail(err)
            }
          )
        })
      })

      zipfile.on('end', () => {
        if (settled) return
        settled = true
        const missing = wanted.filter((w) => !found.has(w))
        reject(new Error('Archive did not contain: ' + missing.join(', ')))
      })

      zipfile.on('error', fail)
      zipfile.readEntry()
    })
  })
}

export interface FfmpegProgress {
  phase: 'download' | 'extract'
  receivedBytes: number
  totalBytes: number | null
  percent: number | null
}

/**
 * Downloads an ffmpeg build and extracts ffmpeg.exe + ffprobe.exe into `binDir`.
 * The zip is deleted afterwards. Falls back to the secondary mirror if the
 * primary one fails outright.
 */
export async function downloadFfmpeg(
  binDir: string,
  cacheDir: string,
  onProgress: (p: FfmpegProgress) => void,
  signal?: AbortSignal
): Promise<void> {
  const zipPath = join(cacheDir, 'ffmpeg-build.zip')
  let lastError: Error | null = null

  for (const url of FFMPEG_URLS) {
    try {
      await downloadToFile(
        url,
        zipPath,
        MIN_ZIP_BYTES,
        (p) => onProgress({ phase: 'download', ...p }),
        signal
      )

      onProgress({ phase: 'extract', receivedBytes: 0, totalBytes: 2, percent: 0 })
      await extractBinariesFromZip(
        zipPath,
        {
          'ffmpeg.exe': join(binDir, 'ffmpeg.exe'),
          'ffprobe.exe': join(binDir, 'ffprobe.exe')
        },
        (extracted, total) =>
          onProgress({
            phase: 'extract',
            receivedBytes: extracted,
            totalBytes: total,
            percent: (extracted / total) * 100
          })
      )

      await rm(zipPath, { force: true })
      return
    } catch (err) {
      lastError = err as Error
      await rm(zipPath, { force: true }).catch(() => {})
      if (signal?.aborted) throw err
    }
  }

  throw new Error('Could not obtain ffmpeg: ' + (lastError?.message ?? 'unknown error'))
}
