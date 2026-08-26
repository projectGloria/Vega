export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—'
  if (bytes < 1024) return bytes + ' B'

  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return value.toFixed(value < 10 ? 1 : 0) + ' ' + units[unit]
}

export function formatSpeed(bytesPerSecond: number | null): string {
  if (!bytesPerSecond) return ''
  return formatBytes(bytesPerSecond) + '/s'
}

/** Clock format for video length: 3:07 or 1:04:22. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return ''

  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')

  return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s)
}

/** Countdown format for ETA, which reads better as "2m 04s" than "0:02:04". */
export function formatEta(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return ''

  const total = Math.round(seconds)
  if (total < 60) return total + 's left'

  const m = Math.floor(total / 60)
  const s = total % 60
  if (m < 60) return m + 'm ' + String(s).padStart(2, '0') + 's left'

  const h = Math.floor(m / 60)
  return h + 'h ' + String(m % 60).padStart(2, '0') + 'm left'
}

export function looksLikeUrl(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed || /\s/.test(trimmed)) return false
  try {
    const parsed = new URL(trimmed)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/** The site a link came from, for the one-line meta row under a title. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** Midnight this morning, used to pick out "downloaded today" from history. */
export function startOfToday(): number {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
}

/**
 * Date for a history row: the clock alone for today, the day for anything
 * older. A list where every row says the same date is not telling you anything.
 */
export function formatWhen(epochMs: number): string {
  const date = new Date(epochMs)
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  if (epochMs >= startOfToday()) return 'Today, ' + time
  if (epochMs >= startOfToday() - 86_400_000) return 'Yesterday, ' + time

  return date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' + time
}
