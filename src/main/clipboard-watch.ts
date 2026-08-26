import { clipboard } from 'electron'
import { getSettings } from './store'
import { isMediaUrl } from './media-sites'

const POLL_INTERVAL_MS = 1200

/**
 * Electron has no clipboard-change event, so detecting a copied link means
 * polling. Two rules keep that from being creepy or annoying:
 *
 *  - nothing is read unless the user has the setting on, and nothing is ever
 *    stored or logged — a non-URL clipboard is compared and discarded;
 *  - the link is *offered*, never inserted. Silently overwriting the input the
 *    user is typing in would be hostile.
 *
 * Only links from known media sites get through. Copying a repo URL or a docs
 * page should cost nothing at all — not a yt-dlp process, and not a failed row
 * to dismiss later.
 */
export class ClipboardWatcher {
  private timer: NodeJS.Timeout | null = null
  private lastSeen: string | null = null

  constructor(private onLink: (url: string) => void) {}

  start(): void {
    if (this.timer) return

    // Seed with whatever is already on the clipboard so the app does not
    // announce a link the user copied before it launched.
    this.lastSeen = safeRead()

    this.timer = setInterval(() => this.tick(), POLL_INTERVAL_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  /** Marks a URL as already handled, so acting on it does not re-offer it. */
  acknowledge(url: string): void {
    this.lastSeen = url
  }

  private tick(): void {
    if (!getSettings().watchClipboard) return

    const text = safeRead()
    if (text === null || text === this.lastSeen) return

    this.lastSeen = text

    const url = asHttpUrl(text)
    if (url && isMediaUrl(url)) this.onLink(url)
  }
}

function safeRead(): string | null {
  try {
    return clipboard.readText()
  } catch {
    // Another process can hold the clipboard open; skip this tick.
    return null
  }
}

/** Returns the URL only if the clipboard holds a bare http(s) link. */
function asHttpUrl(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed || trimmed.length > 2048 || /\s/.test(trimmed)) return null

  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.toString()
  } catch {
    return null
  }
}
