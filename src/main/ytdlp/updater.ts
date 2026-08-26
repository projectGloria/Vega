import { getPaths } from '../bootstrap/paths'
import { probeYtdlp } from '../bootstrap/probe'
import { binaryVersions } from '../bootstrap/index'
import { getSettings, updateSettings } from '../store'
import { runCapture } from './runner'
import { log } from '../log'

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
/** Long enough that the check never competes with the splash for attention. */
const STARTUP_DELAY_MS = 30_000

/**
 * Sites change their players constantly, and a stale yt-dlp is the single most
 * common reason a download that "worked yesterday" fails today. This keeps it
 * current in the background — never on the startup path, and never when the
 * user has turned it off.
 */
export async function checkForYtdlpUpdate(force = false): Promise<{ ok: boolean; message: string }> {
  const paths = getPaths()
  const settings = getSettings()

  if (!force && !settings.autoUpdateYtdlp) {
    return { ok: true, message: 'Automatic updates are turned off.' }
  }

  const age = Date.now() - (settings.lastYtdlpUpdateCheck ?? 0)
  if (!force && age < CHECK_INTERVAL_MS) {
    return { ok: true, message: 'Checked recently.' }
  }

  try {
    const { stdout } = await runCapture(paths.ytdlpExe, ['-U'], 120_000)
    binaryVersions.ytdlp = await probeYtdlp(paths.ytdlpExe).catch(() => binaryVersions.ytdlp)
    await updateSettings({ lastYtdlpUpdateCheck: Date.now() })

    const message = stdout.split('\n').filter(Boolean).pop() ?? 'yt-dlp is up to date.'
    log.info('yt-dlp update check:', message)
    return { ok: true, message }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn('yt-dlp update check failed:', message)
    // A failed check must not block anything; the existing binary still works.
    return { ok: false, message }
  }
}

/** Schedules the background check well after the UI has settled. */
export function scheduleYtdlpUpdateCheck(): NodeJS.Timeout {
  return setTimeout(() => {
    void checkForYtdlpUpdate()
  }, STARTUP_DELAY_MS)
}
