import type { BootstrapState, BootstrapStep, BootstrapStepId, BinaryVersions } from '@shared/types'
import { ensureDirs, getPaths } from './paths'
import { downloadFfmpeg, downloadYtdlp } from './provision'
import { clearStaleParts, fileExists, probeFfmpeg, probeYtdlp, pruneCache } from './probe'
import { isWritable, loadSettings, updateSettings } from '../store'

const STEP_LABELS: Record<BootstrapStepId, string> = {
  appdata: 'Preparing app data',
  ytdlp: 'Checking yt-dlp',
  ffmpeg: 'Checking ffmpeg',
  probe: 'Verifying components',
  cache: 'Tidying cache',
  settings: 'Loading preferences'
}

const STEP_ORDER: BootstrapStepId[] = ['appdata', 'ytdlp', 'ffmpeg', 'probe', 'cache', 'settings']

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return value.toFixed(value < 10 ? 1 : 0) + ' ' + units[unit]
}

export const binaryVersions: BinaryVersions = { ytdlp: null, ffmpeg: null }

export class Bootstrapper {
  private steps: BootstrapStep[]
  private error: BootstrapState['error'] = null
  private done = false
  private abort = new AbortController()

  constructor(private emit: (state: BootstrapState) => void) {
    this.steps = STEP_ORDER.map((id) => ({
      id,
      label: STEP_LABELS[id],
      status: 'pending',
      percent: null,
      detail: null
    }))
  }

  private get state(): BootstrapState {
    // Each step contributes an equal slice; a running step contributes its own fraction.
    const per = 100 / this.steps.length
    const overall = this.steps.reduce((sum, s) => {
      if (s.status === 'done' || s.status === 'skipped') return sum + per
      if (s.status === 'running' && s.percent !== null) return sum + (per * s.percent) / 100
      return sum
    }, 0)

    return {
      steps: this.steps.map((s) => ({ ...s })),
      overall: Math.min(100, Math.round(overall)),
      done: this.done,
      error: this.error
    }
  }

  private patch(id: BootstrapStepId, patch: Partial<BootstrapStep>): void {
    const step = this.steps.find((s) => s.id === id)
    if (!step) return
    Object.assign(step, patch)
    this.emit(this.state)
  }

  cancel(): void {
    this.abort.abort()
  }

  /**
   * Runs every step in order. Throwing inside a step marks it failed and stops
   * the run; the splash then offers Retry or Continue anyway rather than
   * hanging on a spinner forever.
   */
  async run(): Promise<BootstrapState> {
    this.error = null
    this.done = false

    for (const step of this.steps) {
      if (step.status === 'failed') {
        step.status = 'pending'
        step.percent = null
        step.detail = null
      }
    }
    this.emit(this.state)

    try {
      await this.stepAppData()
      await this.stepYtdlp()
      await this.stepFfmpeg()
      await this.stepProbe()
      await this.stepCache()
      await this.stepSettings()
      this.done = true
      this.emit(this.state)
    } catch (err) {
      const failing = this.steps.find((s) => s.status === 'running')
      const id = failing?.id ?? 'probe'
      const message = err instanceof Error ? err.message : String(err)

      this.patch(id, { status: 'failed', detail: message.slice(0, 300) })
      this.error = {
        step: id,
        message,
        // Without yt-dlp there is nothing to continue to; other failures degrade gracefully.
        canContinue: id !== 'ytdlp' && id !== 'appdata'
      }
      this.emit(this.state)
    }

    return this.state
  }

  /** Marks the run usable despite a non-fatal failure (user chose "Continue anyway"). */
  forceComplete(): BootstrapState {
    this.error = null
    this.done = true
    this.emit(this.state)
    return this.state
  }

  private async stepAppData(): Promise<void> {
    this.patch('appdata', { status: 'running', percent: null })
    const paths = ensureDirs()
    // A killed provisioning run leaves .part files behind; clear them before reusing bin/.
    await clearStaleParts(paths.bin)
    await clearStaleParts(paths.cache)
    this.patch('appdata', { status: 'done', percent: 100, detail: null })
  }

  private async stepYtdlp(): Promise<void> {
    const paths = getPaths()
    this.patch('ytdlp', { status: 'running', percent: null })

    if (await fileExists(paths.ytdlpExe)) {
      this.patch('ytdlp', { status: 'done', percent: 100, detail: 'Already installed' })
      return
    }

    this.patch('ytdlp', { detail: 'Downloading…', percent: 0 })
    await downloadYtdlp(
      paths.ytdlpExe,
      (p) => {
        this.patch('ytdlp', {
          percent: p.percent,
          detail: p.totalBytes
            ? formatBytes(p.receivedBytes) + ' / ' + formatBytes(p.totalBytes)
            : formatBytes(p.receivedBytes)
        })
      },
      this.abort.signal
    )
    this.patch('ytdlp', { status: 'done', percent: 100, detail: 'Downloaded' })
  }

  private async stepFfmpeg(): Promise<void> {
    const paths = getPaths()
    this.patch('ffmpeg', { status: 'running', percent: null })

    const haveBoth =
      (await fileExists(paths.ffmpegExe)) && (await fileExists(paths.ffprobeExe))
    if (haveBoth) {
      this.patch('ffmpeg', { status: 'done', percent: 100, detail: 'Already installed' })
      return
    }

    this.patch('ffmpeg', { detail: 'Downloading…', percent: 0 })
    await downloadFfmpeg(
      paths.bin,
      paths.cache,
      (p) => {
        if (p.phase === 'extract') {
          this.patch('ffmpeg', { percent: 100, detail: 'Extracting…' })
          return
        }
        this.patch('ffmpeg', {
          percent: p.percent,
          detail: p.totalBytes
            ? formatBytes(p.receivedBytes) + ' / ' + formatBytes(p.totalBytes)
            : formatBytes(p.receivedBytes)
        })
      },
      this.abort.signal
    )
    this.patch('ffmpeg', { status: 'done', percent: 100, detail: 'Installed' })
  }

  private async stepProbe(): Promise<void> {
    const paths = getPaths()
    this.patch('probe', { status: 'running', percent: null })

    binaryVersions.ytdlp = await probeYtdlp(paths.ytdlpExe).catch((err: Error) => {
      throw new Error('yt-dlp is present but will not run: ' + err.message)
    })

    binaryVersions.ffmpeg = await probeFfmpeg(paths.ffmpegExe).catch(() => null)

    this.patch('probe', {
      status: 'done',
      percent: 100,
      detail: 'yt-dlp ' + binaryVersions.ytdlp + (binaryVersions.ffmpeg ? ' · ffmpeg ok' : '')
    })
  }

  private async stepCache(): Promise<void> {
    const paths = getPaths()
    this.patch('cache', { status: 'running', percent: null })
    const reclaimed = await pruneCache(paths.cache)
    this.patch('cache', {
      status: 'done',
      percent: 100,
      detail: reclaimed > 0 ? 'Freed ' + formatBytes(reclaimed) : 'Nothing to clean'
    })
  }

  private async stepSettings(): Promise<void> {
    this.patch('settings', { status: 'running', percent: null })
    const settings = await loadSettings()

    // A download folder on a removed drive would fail every download; fall back early.
    if (!(await isWritable(settings.downloadDir))) {
      const fallback = getPaths().defaultDownloadDir
      await updateSettings({ downloadDir: fallback })
      this.patch('settings', {
        status: 'done',
        percent: 100,
        detail: 'Download folder reset to default'
      })
      return
    }

    this.patch('settings', { status: 'done', percent: 100, detail: null })
  }
}
