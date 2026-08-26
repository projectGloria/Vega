import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  AudioCodec,
  DownloadRequest,
  DownloadSelection,
  PlaylistEntry,
  VideoInfo
} from '@shared/types'
import type { EntryDetail, QuickQuality } from '../store/app'
import { IDLE_DETAIL, useApp } from '../store/app'
import { toast } from '../store/toasts'
import { formatBytes, formatDuration, hostOf } from '../lib/format'
import FormatOptions, { estimateForSelection } from './FormatOptions'
import CategoryPicker from './CategoryPicker'
import { AlertIcon, CloseIcon, DownloadIcon, RetryIcon, VideoIcon } from './Icons'

const PLAYLIST_HEIGHTS = [2160, 1440, 1080, 720, 480, 360]
const PLAYLIST_CODECS: AudioCodec[] = ['mp3', 'm4a', 'opus', 'flac']

/**
 * Where a read link becomes a download.
 *
 * The probe runs in the background as the link is pasted, so by the time this
 * opens the formats are usually already in — the spinner is the exception, not
 * the rule.
 */
export default function DownloadSheet() {
  const open = useApp((s) => s.sheetOpen)
  const close = useApp((s) => s.closeSheet)
  const url = useApp((s) => s.url)
  const status = useApp((s) => s.probeStatus)
  const error = useApp((s) => s.probeError)
  const video = useApp((s) => s.video)
  const playlist = useApp((s) => s.playlist)
  const probe = useApp((s) => s.probe)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center p-6 bg-abyss/70 backdrop-blur-[6px] fade-up"
      onClick={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="New download"
        className={
          'pop-in w-full max-h-full flex flex-col rounded-2xl bg-surface border border-line-strong shadow-[0_30px_80px_rgba(0,0,0,0.6)] overflow-hidden ' +
          // A list of videos needs room for a thumbnail and a format menu on
          // every row; a single video does not.
          (playlist ? 'max-w-[820px]' : 'max-w-[560px]')
        }
      >
        <header className="flex items-center justify-between px-5 py-4 border-b border-line shrink-0">
          <h3 className="font-display text-[15px] font-bold">
            {playlist
              ? playlist.isChannel
                ? 'Download channel'
                : 'Download playlist'
              : 'New download'}
          </h3>
          <button
            onClick={close}
            aria-label="Close"
            className="w-8 h-8 rounded-lg border border-line bg-white/[0.04] text-muted grid place-items-center hover:bg-white/10 hover:text-ink transition-colors"
          >
            <CloseIcon className="w-[13px] h-[13px]" />
          </button>
        </header>

        {status === 'loading' && <Analyzing url={url} />}

        {status === 'error' && (
          <ProbeError message={error} onRetry={() => void probe(url)} onClose={close} />
        )}

        {status === 'ready' && video && <VideoBody info={video} onClose={close} />}
        {status === 'ready' && playlist && <PlaylistBody onClose={close} />}
      </div>
    </div>
  )
}

function Analyzing({ url }: { url: string }) {
  return (
    <div className="px-5 py-10 flex flex-col items-center gap-4">
      <span
        className="w-9 h-9 rounded-full border-[3px]"
        style={{
          borderColor: 'var(--accent-soft)',
          borderTopColor: 'var(--accent)',
          animation: 'spin 0.8s linear infinite'
        }}
      />
      <p className="text-[13px] text-muted">Reading the link…</p>
      <p className="text-[11px] text-faint font-mono max-w-full truncate px-4">{url}</p>
    </div>
  )
}

function ProbeError({
  message,
  onRetry,
  onClose
}: {
  message: string | null
  onRetry(): void
  onClose(): void
}) {
  return (
    <>
      <div className="px-5 py-6 flex gap-3">
        <span className="w-9 h-9 rounded-xl grid place-items-center shrink-0 bg-err/12 text-err">
          <AlertIcon className="w-[18px] h-[18px]" />
        </span>
        <div className="min-w-0">
          <p className="text-[13.5px] font-semibold text-ink">Could not read that link</p>
          <p className="mt-1.5 text-[12.5px] text-muted leading-relaxed">
            {message ?? 'Something went wrong reading that link.'}
          </p>
        </div>
      </div>
      <footer className="flex justify-end gap-2.5 px-5 py-4 border-t border-line">
        <GhostButton onClick={onClose}>Close</GhostButton>
        <PrimaryButton onClick={onRetry}>
          <RetryIcon className="w-[15px] h-[15px]" />
          Try again
        </PrimaryButton>
      </footer>
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Single video                                                        */
/* ------------------------------------------------------------------ */

/** Turns the URL bar's quick pick into a real selection for this video. */
function seedSelection(
  info: VideoInfo,
  quick: QuickQuality,
  codec: AudioCodec
): DownloadSelection {
  if (quick === 'audio') return { mode: 'audio', codec, quality: 'best' }
  if (quick === 'best') return { mode: 'best' }

  // Nothing at or below the requested height means the cap would do nothing but
  // confuse; fall through to best rather than pretending it applied.
  const match = info.qualities.find((h) => h <= quick)
  return match ? { mode: 'quality', height: match } : { mode: 'best' }
}

function VideoBody({ info, onClose }: { info: VideoInfo; onClose(): void }) {
  const settings = useApp((s) => s.settings)
  const enqueue = useApp((s) => s.enqueue)
  const activeCategoryId = useApp((s) => s.activeCategoryId)
  const quick = useApp((s) => s.quickQuality)

  const [selection, setSelection] = useState<DownloadSelection>(() =>
    seedSelection(info, quick, settings?.audioCodec ?? 'mp3')
  )
  const [embedSubs, setEmbedSubs] = useState(settings?.embedSubs ?? false)
  const [busy, setBusy] = useState(false)

  // A new probe result means a new video; reset the picker to its default.
  useEffect(() => {
    setSelection(seedSelection(info, quick, settings?.audioCodec ?? 'mp3'))
    setEmbedSubs(settings?.embedSubs ?? false)
    // Keyed on the video alone: changing the quick pick in the URL bar must not
    // reach back into a sheet the user is already choosing in.
  }, [info])

  const estimate = useMemo(() => estimateForSelection(info, selection), [info, selection])

  const start = async () => {
    setBusy(true)
    try {
      await enqueue([
        {
          url: info.url,
          title: info.title,
          uploader: info.uploader,
          thumbnail: info.thumbnail,
          duration: info.duration,
          selection,
          categoryId: activeCategoryId,
          subtitleLangs: settings?.subtitleLangs,
          embedSubs: embedSubs && selection.mode !== 'audio',
          embedThumbnail: settings?.embedThumbnail ?? true,
          embedMetadata: settings?.embedMetadata ?? true,
          sponsorblock: settings?.sponsorblock ?? false
        }
      ])
      toast('info', 'Download started', info.title)
    } catch (err) {
      toast('danger', 'Could not start that download', errorText(err))
      setBusy(false)
    }
  }

  return (
    <>
      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-5 space-y-4">
        <div className="flex gap-3.5">
          <Preview
            thumbnail={info.thumbnail}
            duration={info.duration}
            className="w-[132px] h-[74px]"
          />
          <div className="min-w-0 flex-1">
            <h4 className="text-[13.5px] font-semibold leading-snug line-clamp-2">{info.title}</h4>
            <div className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-faint flex-wrap">
              <span className="truncate max-w-[160px]">{info.uploader ?? hostOf(info.url)}</span>
              {info.duration !== null && (
                <>
                  <span>·</span>
                  <span className="tabular-nums">{formatDuration(info.duration)}</span>
                </>
              )}
              <span>·</span>
              <span style={{ color: 'var(--color-ok)' }}>
                {info.isLive ? 'Live' : 'Available'}
              </span>
            </div>
            {info.isLive && (
              <p className="mt-1.5 text-[11px] text-warn/90 leading-relaxed">
                A live stream is captured from now until you stop it, so there is no total size.
              </p>
            )}
          </div>
        </div>

        <FormatOptions
          info={info}
          selection={selection}
          onChange={setSelection}
          embedSubs={embedSubs}
          onEmbedSubsChange={setEmbedSubs}
        />

        <div className="pt-3 border-t border-line">
          <CategoryPicker />
        </div>
      </div>

      <footer className="flex items-center gap-2.5 px-5 py-4 border-t border-line shrink-0">
        <span className="text-[11.5px] text-faint tabular-nums">
          {estimate !== null ? '≈ ' + formatBytes(estimate) : 'Size not reported'}
        </span>
        <div className="flex-1" />
        <GhostButton onClick={onClose}>Cancel</GhostButton>
        <PrimaryButton onClick={start} disabled={busy}>
          <DownloadIcon className="w-[15px] h-[15px]" />
          Start download
        </PrimaryButton>
      </footer>
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Playlist                                                            */
/* ------------------------------------------------------------------ */

/** Rows rendered at once; more are added as the list is scrolled. */
const ROW_PAGE = 60

/** How a row's own format is written into the <select>. */
function selectionValue(selection: DownloadSelection | undefined): string {
  if (!selection) return 'default'
  switch (selection.mode) {
    case 'best':
      return 'best'
    case 'audio':
      return 'audio'
    case 'quality':
      return 'h' + selection.height
    case 'format':
      return 'custom'
  }
}

function selectionLabel(selection: DownloadSelection): string {
  switch (selection.mode) {
    case 'best':
      return 'Best'
    case 'quality':
      return 'Up to ' + selection.height + 'p'
    case 'audio':
      return selection.codec.toUpperCase()
    case 'format':
      return 'Custom'
  }
}

/**
 * What this particular video will actually come down as.
 *
 * A cap is a ceiling, not a promise: "up to 1080p" on a video that only exists
 * at 480p is 480p, and saying so per row is the whole point of reading them
 * separately. Falls back to the intent until the row has been probed.
 */
function effectiveLabel(info: VideoInfo | null, selection: DownloadSelection): string {
  if (!info) return selectionLabel(selection)

  if (selection.mode === 'quality') {
    // qualities is descending, so the first match is the tallest under the cap.
    const height = info.qualities.find((h) => h <= selection.height)
    return height ? height + 'p' : selectionLabel(selection)
  }
  if (selection.mode === 'best') {
    const height = info.qualities[0]
    return height ? height + 'p' : 'Best'
  }
  return selectionLabel(selection)
}

/**
 * Queues a row's own probe the first time it comes near the viewport.
 *
 * A channel can be hundreds of rows; probing them all on open would mean
 * hundreds of yt-dlp runs for a list the user is about to scroll past.
 */
function useDetailOnView(url: string) {
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const element = ref.current
    if (!element) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return
        observer.disconnect()
        useApp.getState().requestEntryDetail(url)
      },
      // Start a little before the row is actually on screen, so a slow scroll
      // finds the details already there.
      { rootMargin: '250px 0px' }
    )

    observer.observe(element)
    return () => observer.disconnect()
  }, [url])

  return ref
}

/**
 * One video from the list, read and chosen on its own terms: its own
 * thumbnail, its own quality list, its own size, its own in/out tick.
 */
function EntryRow({
  entry,
  index,
  batch,
  codec
}: {
  entry: PlaylistEntry
  index: number
  batch: DownloadSelection
  codec: AudioCodec
}) {
  const isSelected = useApp((s) => s.selectedEntries.has(entry.url))
  const detail = useApp((s) => s.entryDetails[entry.url]) ?? IDLE_DETAIL
  const override = useApp((s) => s.entrySelections[entry.url])
  const toggleEntry = useApp((s) => s.toggleEntry)
  const setEntrySelection = useApp((s) => s.setEntrySelection)
  const retryEntryDetail = useApp((s) => s.retryEntryDetail)

  const ref = useDetailOnView(entry.url)

  const info = detail.info
  const selection = override ?? batch
  const size = info ? estimateForSelection(info, selection) : null

  // Before the probe lands there is no format list to offer, so the generic
  // ladder stands in — picking 1080p on an unread row is still meaningful.
  const heights = info && info.qualities.length > 0 ? info.qualities : PLAYLIST_HEIGHTS
  const audioCodec = override?.mode === 'audio' ? override.codec : codec

  const change = (value: string) => {
    if (value === 'default') setEntrySelection(entry.url, null)
    else if (value === 'best') setEntrySelection(entry.url, { mode: 'best' })
    else if (value === 'audio') {
      setEntrySelection(entry.url, { mode: 'audio', codec, quality: 'best' })
    } else setEntrySelection(entry.url, { mode: 'quality', height: Number(value.slice(1)) })
  }

  return (
    <div
      ref={ref}
      className={
        'flex items-center gap-3 px-5 py-2.5 border-b border-line/60 transition-colors ' +
        (isSelected ? 'hover:bg-white/[0.04]' : 'opacity-55 hover:opacity-80')
      }
    >
      {/*
        A div rather than a button: the row carries a retry link and a preview
        of its own, and neither is legal inside a <button>. The checkbox role
        and the key handler put back what the element gives up.
      */}
      <div
        onClick={() => toggleEntry(entry.url)}
        onKeyDown={(e) => {
          if (e.key !== ' ' && e.key !== 'Enter') return
          e.preventDefault()
          toggleEntry(entry.url)
        }}
        role="checkbox"
        tabIndex={0}
        aria-checked={isSelected}
        aria-label={entry.title}
        className="flex items-center gap-3 min-w-0 flex-1 text-left cursor-pointer"
      >
        <span
          className={
            'w-[18px] h-[18px] rounded-[6px] border grid place-items-center shrink-0 transition-all duration-150 ' +
            (isSelected ? 'border-transparent' : 'border-line-strong')
          }
          style={isSelected ? { background: 'var(--accent)' } : undefined}
        >
          {isSelected && (
            <svg viewBox="0 0 24 24" className="w-3 h-3" fill="none" stroke="#0b0e15" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <path d="m5 12.5 4.5 4.5L19 7.5" />
            </svg>
          )}
        </span>

        <span className="text-[11.5px] text-faint tabular-nums w-6 shrink-0">{index + 1}</span>

        <Preview
          thumbnail={info?.thumbnail ?? entry.thumbnail}
          duration={info?.duration ?? entry.duration}
          className="w-[86px] h-[48px]"
        />

        <div className="min-w-0 flex-1">
          <div
            className={
              'truncate text-[12.5px] ' + (isSelected ? 'text-ink' : 'text-muted')
            }
          >
            {entry.title}
          </div>
          <EntryMeta
            entry={entry}
            detail={detail}
            label={effectiveLabel(info, selection)}
            size={size}
            onRetry={() => retryEntryDetail(entry.url)}
          />
        </div>
      </div>

      <div className="shrink-0">
        <Select
          value={selectionValue(override)}
          onChange={change}
          aria-label={'Format for ' + entry.title}
        >
          <option value="default" className="bg-raised">
            Default · {selectionLabel(batch)}
          </option>
          <option value="best" className="bg-raised">
            Best
          </option>
          {heights.map((h) => (
            <option key={h} value={'h' + h} className="bg-raised">
              Up to {h}p
            </option>
          ))}
          <option value="audio" className="bg-raised">
            Audio · {audioCodec.toUpperCase()}
          </option>
        </Select>
      </div>
    </div>
  )
}

/** The line under a row title: where it came from, and what it will cost. */
function EntryMeta({
  entry,
  detail,
  label,
  size,
  onRetry
}: {
  entry: PlaylistEntry
  detail: EntryDetail
  label: string
  size: number | null
  onRetry(): void
}) {
  if (detail.status === 'error') {
    return (
      <span className="mt-0.5 flex items-center gap-1.5 text-[11px]">
        <span className="text-err/90 truncate">{detail.error ?? 'Could not read this one'}</span>
        <button
          onClick={(e) => {
            e.stopPropagation()
            onRetry()
          }}
          className="text-muted hover:text-ink underline underline-offset-2 shrink-0"
        >
          Retry
        </button>
      </span>
    )
  }

  const uploader = detail.info?.uploader ?? entry.uploader

  return (
    <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-faint">
      {entry.section && (
        <>
          <span className="px-1.5 py-px rounded bg-white/[0.06] text-[10px] shrink-0">
            {entry.section}
          </span>
          <span>·</span>
        </>
      )}
      {uploader && (
        <>
          <span className="truncate max-w-[140px]">{uploader}</span>
          <span>·</span>
        </>
      )}
      <span
        className="shrink-0 font-semibold"
        style={detail.info ? { color: 'var(--accent)' } : undefined}
      >
        {label}
      </span>
      <span>·</span>
      {detail.status === 'ready' ? (
        <span className="tabular-nums shrink-0">
          {size !== null ? '≈ ' + formatBytes(size) : 'size not reported'}
        </span>
      ) : (
        <span className="shrink-0 opacity-70">
          {detail.status === 'loading' ? 'reading…' : 'not read yet'}
        </span>
      )}
    </span>
  )
}

/**
 * A playlist or channel is a list of separate videos, not one download: every
 * row is read, sized, previewed and chosen on its own, and each ends up as its
 * own queue item. The picker at the top is only the default that rows fall back
 * to — anything set on a row wins.
 */
function PlaylistBody({ onClose }: { onClose(): void }) {
  const info = useApp((s) => s.playlist)
  const selected = useApp((s) => s.selectedEntries)
  const details = useApp((s) => s.entryDetails)
  const overrides = useApp((s) => s.entrySelections)
  const setAllEntries = useApp((s) => s.setAllEntries)
  const setEntrySelection = useApp((s) => s.setEntrySelection)
  const clearEntrySelections = useApp((s) => s.clearEntrySelections)
  const requestAllEntryDetails = useApp((s) => s.requestAllEntryDetails)
  const settings = useApp((s) => s.settings)
  const enqueue = useApp((s) => s.enqueue)
  const activeCategoryId = useApp((s) => s.activeCategoryId)
  const quick = useApp((s) => s.quickQuality)

  const [mode, setMode] = useState<'video' | 'audio'>(quick === 'audio' ? 'audio' : 'video')
  const [height, setHeight] = useState<number>(typeof quick === 'number' ? quick : 1080)
  const [codec, setCodec] = useState<AudioCodec>(settings?.audioCodec ?? 'mp3')
  const [limit, setLimit] = useState(ROW_PAGE)
  const [busy, setBusy] = useState(false)

  const entries = useMemo(() => info?.entries ?? [], [info])

  const batch: DownloadSelection =
    mode === 'audio' ? { mode: 'audio', codec, quality: 'best' } : { mode: 'quality', height }

  const chosen = useMemo(
    () => entries.filter((e) => selected.has(e.url)),
    [entries, selected]
  )
  const allSelected = chosen.length === entries.length && entries.length > 0

  /** Only the rows that have been read can be counted; the rest are honest gaps. */
  const total = useMemo(() => {
    let bytes = 0
    let unknown = 0
    for (const entry of chosen) {
      const entryInfo = details[entry.url]?.info
      const size = entryInfo
        ? estimateForSelection(entryInfo, overrides[entry.url] ?? batch)
        : null
      if (size === null) unknown++
      else bytes += size
    }
    return { bytes, unknown }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosen, details, overrides, mode, height, codec])

  const unread = entries.length - entries.filter((e) => details[e.url]?.status === 'ready').length

  // Switching the batch codec has to follow the rows that were put on audio by
  // hand, or their menu would say FLAC while they downloaded mp3.
  const changeCodec = (next: AudioCodec) => {
    setCodec(next)
    for (const [url, selection] of Object.entries(overrides)) {
      if (selection.mode === 'audio') setEntrySelection(url, { ...selection, codec: next })
    }
  }

  if (!info) return null

  const start = async () => {
    setBusy(true)
    try {
      const requests: DownloadRequest[] = chosen.map((entry) => {
        const entryInfo = details[entry.url]?.info
        return {
          url: entry.url,
          title: entryInfo?.title ?? entry.title,
          uploader: entryInfo?.uploader ?? entry.uploader ?? info.uploader,
          // The probed thumbnail is the full-size one; the flat list carries
          // whatever grid image the site happened to hand back.
          thumbnail: entryInfo?.thumbnail ?? entry.thumbnail,
          duration: entryInfo?.duration ?? entry.duration,
          selection: overrides[entry.url] ?? batch,
          categoryId: activeCategoryId,
          subtitleLangs: settings?.subtitleLangs,
          embedSubs: settings?.embedSubs ?? false,
          embedThumbnail: settings?.embedThumbnail ?? true,
          embedMetadata: settings?.embedMetadata ?? true,
          sponsorblock: settings?.sponsorblock ?? false
        }
      })
      await enqueue(requests)
      toast('info', 'Queued ' + requests.length + ' downloads', info.title)
    } catch (err) {
      toast('danger', 'Could not queue that playlist', errorText(err))
      setBusy(false)
    }
  }

  return (
    <>
      <div className="flex-1 min-h-0 flex flex-col">
        <div className="px-5 pt-5 pb-3 shrink-0">
          <div className="flex items-center gap-2">
            <span
              className="px-2 py-0.5 rounded-md text-[11px] font-semibold"
              style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
            >
              {info.isChannel ? 'Channel' : 'Playlist'}
            </span>
            <span className="text-[12px] text-faint tabular-nums">
              {entries.length} videos
            </span>
          </div>
          <h4 className="mt-2 text-[14px] font-semibold leading-snug line-clamp-1">
            {info.title}
          </h4>
          {info.uploader && (
            <p className="mt-0.5 text-[12px] text-faint truncate">{info.uploader}</p>
          )}

          <div className="mt-3.5 flex flex-wrap items-center gap-2.5">
            <span className="text-[11.5px] text-faint">Default</span>
            <div className="flex items-center gap-1 p-1 rounded-[10px] bg-black/25 border border-line">
              <ModeTab active={mode === 'video'} onClick={() => setMode('video')} label="Video" />
              <ModeTab active={mode === 'audio'} onClick={() => setMode('audio')} label="Audio" />
            </div>

            {mode === 'video' ? (
              <Select value={String(height)} onChange={(v) => setHeight(Number(v))}>
                {PLAYLIST_HEIGHTS.map((h) => (
                  <option key={h} value={h} className="bg-raised">
                    Up to {h}p
                  </option>
                ))}
              </Select>
            ) : (
              <Select value={codec} onChange={(v) => changeCodec(v as AudioCodec)}>
                {PLAYLIST_CODECS.map((c) => (
                  <option key={c} value={c} className="bg-raised">
                    {c.toUpperCase()}
                  </option>
                ))}
              </Select>
            )}

            <div className="flex-1" />

            <button
              onClick={() => setAllEntries(!allSelected)}
              className="text-[12px] text-muted hover:text-ink transition-colors"
            >
              {allSelected ? 'Deselect all' : 'Select all'}
            </button>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11.5px]">
            {unread > 0 ? (
              <button
                onClick={requestAllEntryDetails}
                className="text-muted hover:text-ink underline underline-offset-2 transition-colors"
              >
                Read all {entries.length} for sizes
              </button>
            ) : (
              <span className="text-faint">All {entries.length} read</span>
            )}
            {Object.keys(overrides).length > 0 && (
              <>
                <span className="text-faint">·</span>
                <span className="text-faint tabular-nums">
                  {Object.keys(overrides).length} set individually
                </span>
                <button
                  onClick={clearEntrySelections}
                  className="text-muted hover:text-ink underline underline-offset-2 transition-colors"
                >
                  Reset
                </button>
              </>
            )}
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto border-t border-line">
          {entries.slice(0, limit).map((entry, index) => (
            <EntryRow
              key={entry.url}
              entry={entry}
              index={index}
              batch={batch}
              codec={codec}
            />
          ))}
          {limit < entries.length && (
            <MoreRows
              remaining={entries.length - limit}
              onReach={() => setLimit((current) => Math.min(current + ROW_PAGE, entries.length))}
            />
          )}
        </div>

        <div className="px-5 py-3 border-t border-line shrink-0">
          <CategoryPicker />
        </div>
      </div>

      <footer className="flex items-center gap-2.5 px-5 py-4 border-t border-line shrink-0">
        <span className="text-[11.5px] text-faint tabular-nums">
          {chosen.length} of {entries.length} selected
          {chosen.length > 0 && (
            <>
              {' · ≈ '}
              {formatBytes(total.bytes)}
              {total.unknown > 0 && ' + ' + total.unknown + ' unread'}
            </>
          )}
        </span>
        <div className="flex-1" />
        <GhostButton onClick={onClose}>Cancel</GhostButton>
        <PrimaryButton onClick={start} disabled={busy || chosen.length === 0}>
          <DownloadIcon className="w-[15px] h-[15px]" />
          {chosen.length > 0 ? 'Download ' + chosen.length : 'Select items'}
        </PrimaryButton>
      </footer>
    </>
  )
}

/**
 * The tail of a long list. Rows are rendered a page at a time — a channel with
 * two thousand videos would otherwise put two thousand rows and their images in
 * the DOM before the sheet could paint.
 */
function MoreRows({ remaining, onReach }: { remaining: number; onReach(): void }) {
  const ref = useRef<HTMLDivElement | null>(null)
  // Kept in a ref so growing the list does not tear down the observer: a fresh
  // one re-fires the moment it is attached, and the sentinel would keep paying
  // out pages while it sat on screen.
  const reach = useRef(onReach)
  reach.current = onReach

  useEffect(() => {
    const element = ref.current
    if (!element) return

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) reach.current()
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return (
    <div ref={ref} className="px-5 py-4 text-center text-[11.5px] text-faint tabular-nums">
      {remaining} more…
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Shared bits                                                         */
/* ------------------------------------------------------------------ */

function Preview({
  thumbnail,
  duration,
  className
}: {
  thumbnail: string | null
  duration: number | null
  className: string
}) {
  const [failed, setFailed] = useState(false)

  return (
    <div
      className={
        'relative rounded-[9px] overflow-hidden shrink-0 bg-black border border-line ' + className
      }
    >
      {thumbnail && !failed ? (
        <img
          src={thumbnail}
          alt=""
          onError={() => setFailed(true)}
          referrerPolicy="no-referrer"
          className="w-full h-full object-cover"
        />
      ) : (
        <div className="w-full h-full grid place-items-center">
          <VideoIcon className="w-5 h-5 text-faint opacity-50" />
        </div>
      )}
      {duration !== null && (
        <span className="absolute right-1 bottom-1 px-[5px] py-0.5 rounded bg-black/75 text-[10px] font-semibold tabular-nums">
          {formatDuration(duration)}
        </span>
      )}
    </div>
  )
}

function ModeTab({
  active,
  onClick,
  label
}: {
  active: boolean
  onClick(): void
  label: string
}) {
  return (
    <button
      onClick={onClick}
      className={
        'px-3 py-1 rounded-lg text-[12.5px] transition-all duration-150 ' +
        (active ? 'text-ink bg-white/[0.08]' : 'text-muted hover:text-ink')
      }
    >
      {label}
    </button>
  )
}

function Select({
  value,
  onChange,
  children,
  'aria-label': ariaLabel
}: {
  value: string
  onChange(value: string): void
  children: React.ReactNode
  'aria-label'?: string
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={ariaLabel}
      className="bg-raised border border-line rounded-lg px-2.5 py-1.5 text-[12.5px] text-ink outline-none hover:border-line-strong transition-colors"
    >
      {children}
    </select>
  )
}

export function GhostButton({
  children,
  onClick
}: {
  children: React.ReactNode
  onClick(): void
}) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-2 px-3.5 py-2.5 rounded-[10px] text-[13px] font-semibold
                 border border-line bg-white/5 text-muted hover:bg-white/[0.09] hover:text-ink transition-all"
    >
      {children}
    </button>
  )
}

export function PrimaryButton({
  children,
  onClick,
  disabled
}: {
  children: React.ReactNode
  onClick(): void
  disabled?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-2 px-5 py-2.5 rounded-[10px] text-[13px] font-semibold text-white
                 transition-all duration-150 hover:brightness-110 active:translate-y-px
                 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:brightness-100"
      style={{ background: 'var(--grad)', boxShadow: '0 4px 18px var(--accent-soft)' }}
    >
      {children}
    </button>
  )
}

function errorText(err: unknown): string {
  if (!(err instanceof Error)) return 'Unknown error'
  return err.message.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')
}
