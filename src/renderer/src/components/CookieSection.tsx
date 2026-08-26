import { useEffect, useState } from 'react'
import type { BrowserPresence, CookieBrowser, CookieStatus } from '@shared/types'
import { useApp } from '../store/app'
import { BrowserIcon } from './BrowserIcons'
import { AlertIcon, CheckIcon, TrashIcon } from './Icons'

/**
 * Signing yt-dlp in as your browser.
 *
 * YouTube increasingly answers anonymous requests with "sign in to confirm
 * you're not a bot". Handing yt-dlp the cookies from a browser that is already
 * signed in is what gets past that.
 *
 * Reading them is genuinely unreliable on Windows and fails for two unrelated
 * reasons, so every browser reports its own outcome in place instead of one
 * shared status line — the whole point is knowing *which* browser worked.
 */

type RowState =
  | { kind: 'idle' }
  | { kind: 'working' }
  | { kind: 'failed'; message: string }

export default function CookieSection() {
  const settings = useApp((s) => s.settings)
  const capture = useApp((s) => s.captureCookies)
  const clear = useApp((s) => s.clearCookies)

  const [browsers, setBrowsers] = useState<BrowserPresence[]>([])
  const [states, setStates] = useState<Record<string, RowState>>({})

  useEffect(() => {
    let cancelled = false
    window.api.cookies.browsers().then((list) => {
      if (!cancelled) setBrowsers(list)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const active = settings?.cookies ?? null

  const run = async (browser: CookieBrowser) => {
    setStates((s) => ({ ...s, [browser]: { kind: 'working' } }))
    try {
      await capture(browser)
      setStates((s) => ({ ...s, [browser]: { kind: 'idle' } }))
    } catch (err) {
      setStates((s) => ({ ...s, [browser]: { kind: 'failed', message: cleanError(err) } }))
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-[11.5px] text-faint leading-relaxed">
        Sites like YouTube ask anonymous downloads to prove they are not a bot. Exporting the
        cookies from a browser you are already signed into answers that. Nothing is uploaded — the
        cookies stay on this machine and are passed straight to yt-dlp.
      </p>

      {active && <ActiveBanner status={active} onClear={clear} />}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-2">
        {browsers.map((browser) => (
          <BrowserRow
            key={browser.id}
            browser={browser}
            state={states[browser.id] ?? { kind: 'idle' }}
            isActive={active?.browser === browser.id}
            onRun={() => run(browser.id)}
          />
        ))}
      </div>

      <p className="text-[11px] text-faint leading-relaxed">
        The path under each browser is the <em>profile</em> folder cookies are read from — not where
        the browser is installed. Firefox keeps Release, Developer Edition and Nightly side by side,
        so the release profile is picked deliberately rather than whichever was opened last. Close
        the browser before exporting: Chrome, Brave, Edge, Opera and Vivaldi lock their cookie
        database while running, and newer versions also encrypt it so only the browser itself can
        read it. Firefox has neither restriction.
      </p>
    </div>
  )
}

function ActiveBanner({ status, onClear }: { status: CookieStatus; onClear(): void }) {
  return (
    <div
      className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg border"
      style={{ borderColor: 'var(--accent-line)', background: 'var(--accent-soft)' }}
    >
      <BrowserIcon browser={status.browser} className="w-5 h-5 shrink-0" />

      <div className="flex-1 min-w-0">
        <p className="text-[12.5px] text-ink">
          Using cookies from {labelOf(status.browser)}
          {status.signedIn ? ' — signed in' : ' — not signed in'}
        </p>
        <p className="text-[11px] text-faint tabular-nums">
          {status.cookieCount} cookies · {status.youtubeCount} for YouTube · captured{' '}
          {new Date(status.capturedAt).toLocaleString()}
        </p>
        {status.profileDir && (
          <p className="text-[10.5px] text-faint/80 font-mono truncate" title={status.profileDir}>
            {status.profileDir}
          </p>
        )}
      </div>

      <button
        onClick={onClear}
        title="Stop using these cookies"
        className="p-1.5 rounded-md text-faint hover:text-err hover:bg-err/10 transition-colors shrink-0"
      >
        <TrashIcon className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}

function BrowserRow({
  browser,
  state,
  isActive,
  onRun
}: {
  browser: BrowserPresence
  state: RowState
  isActive: boolean
  onRun(): void
}) {
  const working = state.kind === 'working'
  const failed = state.kind === 'failed'

  return (
    <div
      className={
        'rounded-lg border bg-raised/60 px-3 py-2.5 transition-colors ' +
        (failed ? 'border-err/40' : 'border-line')
      }
    >
      <div className="flex items-center gap-2.5">
        <span className={browser.installed ? '' : 'opacity-35 grayscale'}>
          <BrowserIcon browser={browser.id} />
        </span>

        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-1.5">
            <p className="text-[12.5px] text-ink leading-tight">{browser.label}</p>
            {browser.profileName && (
              <span className="text-[10.5px] text-faint truncate">{browser.profileName}</span>
            )}
          </div>
          <p className="text-[11px] text-faint leading-tight mt-0.5">
            {!browser.installed
              ? 'Not installed'
              : isActive
                ? 'In use'
                : working
                  ? 'Reading cookies…'
                  : 'Ready'}
          </p>
        </div>

        {isActive && !working ? (
          <span
            className="flex items-center gap-1 px-2 py-1.5 rounded-md text-[11px] font-medium shrink-0"
            style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
          >
            <CheckIcon className="w-3.5 h-3.5" />
            Active
          </span>
        ) : (
          <button
            onClick={onRun}
            disabled={!browser.installed || working}
            className={
              'px-2.5 py-1.5 rounded-md text-[11px] font-medium uppercase tracking-wide shrink-0 ' +
              'border transition-colors disabled:opacity-35 disabled:cursor-not-allowed ' +
              (failed
                ? 'border-err/40 text-err/90 hover:bg-err/10'
                : 'border-line text-muted hover:text-ink hover:border-line-strong hover:bg-white/6')
            }
          >
            {working ? 'Reading…' : failed ? 'Retry' : 'Get cookies'}
          </button>
        )}
      </div>

      {browser.profileDir && (
        <p
          className="mt-1.5 text-[10.5px] text-faint/80 font-mono truncate"
          title={browser.profileDir}
        >
          {browser.profileDir}
        </p>
      )}

      {failed && (
        <div className="mt-2 flex gap-1.5 items-start">
          <AlertIcon className="w-3.5 h-3.5 text-err/80 shrink-0 mt-px" />
          <p className="text-[11px] text-err/80 leading-relaxed">{state.message}</p>
        </div>
      )}
    </div>
  )
}

const LABELS: Record<CookieBrowser, string> = {
  brave: 'Brave',
  chrome: 'Chrome',
  edge: 'Edge',
  opera: 'Opera',
  vivaldi: 'Vivaldi',
  firefox: 'Firefox'
}

function labelOf(browser: CookieBrowser): string {
  return LABELS[browser] ?? browser
}

/** Strips Electron's IPC wrapper so the main process's message shows as written. */
function cleanError(err: unknown): string {
  if (!(err instanceof Error)) return 'Could not read cookies.'
  return err.message.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')
}
