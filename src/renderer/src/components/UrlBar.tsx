import { useEffect, useRef, useState } from 'react'
import type { QuickQuality } from '../store/app'
import { useApp } from '../store/app'
import { looksLikeUrl } from '../lib/format'
import { CloseIcon, DownloadIcon, LinkIcon } from './Icons'

/** Debounce so typing a long URL does not fire a probe per keystroke. */
const AUTO_PROBE_DELAY_MS = 450

const QUICK_OPTIONS: { value: string; label: string }[] = [
  { value: 'best', label: 'Best quality' },
  { value: '2160', label: '4K · 2160p' },
  { value: '1440', label: '1440p' },
  { value: '1080', label: '1080p' },
  { value: '720', label: '720p' },
  { value: '480', label: '480p' },
  { value: 'audio', label: 'Audio only' }
]

function toQuick(raw: string): QuickQuality {
  if (raw === 'best' || raw === 'audio') return raw
  return Number(raw)
}

export default function UrlBar() {
  const url = useApp((s) => s.url)
  const setUrl = useApp((s) => s.setUrl)
  const probe = useApp((s) => s.probe)
  const clearProbe = useApp((s) => s.clearProbe)
  const openSheet = useApp((s) => s.openSheet)
  const quick = useApp((s) => s.quickQuality)
  const setQuick = useApp((s) => s.setQuickQuality)
  const autoProbe = useApp((s) => s.settings?.autoProbeOnPaste ?? true)

  const inputRef = useRef<HTMLInputElement>(null)
  const lastProbed = useRef<string>('')
  const [shaking, setShaking] = useState(false)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  /*
   * Reading the link in the background as it is pasted is what makes the sheet
   * open with the formats already in it. It deliberately does not open anything
   * on its own — a modal appearing while someone is still typing is hostile.
   */
  useEffect(() => {
    if (!autoProbe) return

    const trimmed = url.trim()
    if (!looksLikeUrl(trimmed) || trimmed === lastProbed.current) return

    const timer = setTimeout(() => {
      lastProbed.current = trimmed
      void probe(trimmed)
    }, AUTO_PROBE_DELAY_MS)

    return () => clearTimeout(timer)
  }, [url, autoProbe, probe])

  const reject = () => {
    // Restart the animation even when it is already running, so a second bad
    // press is still visibly a rejection rather than nothing at all.
    setShaking(false)
    requestAnimationFrame(() => setShaking(true))
    inputRef.current?.focus()
  }

  const submit = () => {
    const trimmed = url.trim()
    if (!looksLikeUrl(trimmed)) {
      reject()
      return
    }
    lastProbed.current = trimmed
    openSheet(trimmed)
  }

  const handlePaste = async () => {
    const text = (await window.api.system.readClipboard()).trim()
    if (!text) {
      reject()
      return
    }
    setUrl(text)
    inputRef.current?.focus()
    if (looksLikeUrl(text)) {
      lastProbed.current = text
      void probe(text)
    }
  }

  const handleClear = () => {
    lastProbed.current = ''
    clearProbe()
    inputRef.current?.focus()
  }

  const invalid = url.trim().length > 0 && !looksLikeUrl(url.trim())

  return (
    <div className="mb-6">
      <div
        onAnimationEnd={() => setShaking(false)}
        className={
          'flex items-center gap-2 rounded-[14px] border pl-4 pr-2 py-2 transition-all duration-200 bg-surface ' +
          (invalid
            ? 'border-err/40'
            : 'border-line focus-within:border-[var(--accent-line)] focus-within:shadow-[0_0_0_3px_var(--accent-soft)]') +
          (shaking ? ' shake' : '')
        }
      >
        <LinkIcon className="w-[17px] h-[17px] text-faint shrink-0" />

        <input
          ref={inputRef}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
            if (e.key === 'Escape') handleClear()
          }}
          spellCheck={false}
          autoComplete="off"
          placeholder="Paste a video link — YouTube, Vimeo, Twitch…"
          aria-label="Video link"
          className="flex-1 min-w-[60px] bg-transparent border-none outline-none text-[13.5px] text-ink placeholder:text-faint"
        />

        {url.length > 0 && (
          <button
            onClick={handleClear}
            title="Clear"
            aria-label="Clear link"
            className="shrink-0 p-2 rounded-lg text-faint hover:text-ink hover:bg-white/[0.06] transition-colors"
          >
            <CloseIcon className="w-3.5 h-3.5" />
          </button>
        )}

        <button
          onClick={handlePaste}
          className="shrink-0 px-3 py-2 rounded-[10px] text-[13px] font-semibold border border-line bg-white/5 text-muted hover:bg-white/[0.09] hover:text-ink transition-all"
        >
          Paste
        </button>

        <span className="w-px h-[22px] bg-line-strong shrink-0 max-[680px]:hidden" />

        <select
          value={String(quick)}
          onChange={(e) => setQuick(toQuick(e.target.value))}
          aria-label="Preferred quality"
          title="Seeds the quality the download sheet opens on"
          className="shrink-0 appearance-none bg-white/5 border border-line rounded-[9px] text-[12.5px] font-medium
                     text-muted hover:text-ink hover:bg-white/[0.08] pl-3 pr-7 py-2 outline-none cursor-pointer transition-colors max-[680px]:hidden"
          style={{
            backgroundImage:
              "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%238b93a7' stroke-width='1.6' fill='none' stroke-linecap='round'/%3E%3C/svg%3E\")",
            backgroundRepeat: 'no-repeat',
            backgroundPosition: 'right 10px center'
          }}
        >
          {QUICK_OPTIONS.map((option) => (
            <option key={option.value} value={option.value} className="bg-raised text-ink">
              {option.label}
            </option>
          ))}
        </select>

        <button
          onClick={submit}
          className="shrink-0 inline-flex items-center gap-2 px-5 py-2.5 rounded-[10px] text-[13px] font-semibold text-white
                     transition-all duration-150 hover:brightness-110 active:translate-y-px"
          style={{ background: 'var(--grad)', boxShadow: '0 4px 18px var(--accent-soft)' }}
        >
          <DownloadIcon className="w-[15px] h-[15px]" />
          Download
        </button>
      </div>

      {invalid && (
        <p className="mt-2 ml-1 text-[12px] text-err/80">That does not look like a valid link.</p>
      )}
    </div>
  )
}
