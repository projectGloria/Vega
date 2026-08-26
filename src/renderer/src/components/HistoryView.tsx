import { useEffect, useMemo, useState } from 'react'
import type { HistoryEntry } from '@shared/types'
import { formatBytes, formatDuration, formatWhen, hostOf } from '../lib/format'
import { useApp } from '../store/app'
import { confirmAction } from './ConfirmDialog'
import { EmptyState, LinkButton, PageHead } from './Layout'
import { IconButton } from './DownloadCard'
import {
  CheckIcon,
  ClockIcon,
  CopyIcon,
  DownloadIcon,
  FolderIcon,
  SearchIcon,
  TrashIcon,
  VideoIcon
} from './Icons'

/**
 * History outlives the files. An entry stays here after the video is deleted or
 * moved, so the record of what was downloaded — and the link to get it again —
 * is never lost with the file.
 */
export default function HistoryView() {
  const history = useApp((s) => s.history)
  const filter = useApp((s) => s.historyFilter)
  const setFilter = useApp((s) => s.setHistoryFilter)
  const categories = useApp((s) => s.settings?.categories ?? [])

  const [query, setQuery] = useState('')

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return history.filter((entry) => {
      if (filter !== null && entry.categoryId !== filter) return false
      if (!needle) return true
      // Searching the channel too: "that thing from Kurzgesagt" is at least as
      // common a way to look for a download as remembering its title.
      return (
        entry.title.toLowerCase().includes(needle) ||
        (entry.uploader ?? '').toLowerCase().includes(needle)
      )
    })
  }, [history, filter, query])

  // Only offer filters for categories that actually appear in history.
  const usedCategories = useMemo(() => {
    const ids = new Set(history.map((e) => e.categoryId).filter(Boolean))
    return categories.filter((c) => ids.has(c.id))
  }, [history, categories])

  return (
    <>
      <PageHead title="History" subtitle="Everything you've downloaded with Vega.">
        <div className="flex items-center gap-3">
          {history.length > 0 && (
            <LinkButton
              danger
              onClick={() =>
                confirmAction({
                  title: 'Clear all history?',
                  message:
                    'All ' +
                    history.length +
                    ' records are permanently deleted. Downloaded files are not touched, but this list cannot be recovered.',
                  confirmLabel: 'Clear history',
                  onConfirm: () => window.api.history.clear()
                })
              }
            >
              Clear history
            </LinkButton>
          )}
          <div className="relative">
            <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-faint pointer-events-none" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search history…"
              aria-label="Search history"
              spellCheck={false}
              className="w-[230px] bg-surface border border-line rounded-[10px] pl-8 pr-3 py-2 text-[12.5px]
                         text-ink placeholder:text-faint outline-none focus:border-[var(--accent-line)] transition-colors"
            />
          </div>
        </div>
      </PageHead>

      {usedCategories.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap mb-4">
          <FilterChip
            active={filter === null}
            onClick={() => setFilter(null)}
            label="All"
            count={history.length}
          />
          {usedCategories.map((category) => (
            <FilterChip
              key={category.id}
              active={filter === category.id}
              onClick={() => setFilter(category.id)}
              label={category.name}
              count={history.filter((e) => e.categoryId === category.id).length}
            />
          ))}
        </div>
      )}

      {visible.length === 0 ? (
        <EmptyState
          icon={<ClockIcon className="w-6 h-6" />}
          title={history.length === 0 ? 'Nothing downloaded yet' : 'Nothing matches that'}
        >
          {history.length === 0
            ? 'Finished downloads are recorded here with their thumbnail, channel and link — kept even if the file is later moved or deleted.'
            : 'Try a different search or category filter.'}
        </EmptyState>
      ) : (
        visible.map((entry) => <HistoryRow key={entry.id} entry={entry} />)
      )}
    </>
  )
}

function FilterChip({
  active,
  onClick,
  label,
  count
}: {
  active: boolean
  onClick(): void
  label: string
  count: number
}) {
  return (
    <button
      onClick={onClick}
      className={
        'px-2.5 py-1 rounded-lg text-[12px] border transition-all duration-150 ' +
        (active ? 'text-ink' : 'border-line text-muted hover:text-ink hover:border-line-strong')
      }
      style={
        active
          ? { borderColor: 'var(--accent-line)', background: 'var(--accent-soft)' }
          : undefined
      }
    >
      {label}
      <span className="ml-1.5 text-faint tabular-nums">{count}</span>
    </button>
  )
}

function HistoryRow({ entry }: { entry: HistoryEntry }) {
  const openSheet = useApp((s) => s.openSheet)

  const [exists, setExists] = useState<boolean | null>(null)
  const [copied, setCopied] = useState(false)
  const [thumbFailed, setThumbFailed] = useState(false)

  // Three distinct states, and conflating them is what made this lie before:
  // null = we never recorded a path, so we genuinely do not know;
  // false = we have a path and the file is not there;
  // true  = the file is where we left it.
  useEffect(() => {
    let cancelled = false
    if (!entry.outputPath) {
      setExists(null)
      return
    }
    window.api.history.fileExists(entry.outputPath).then((ok) => {
      if (!cancelled) setExists(ok)
    })
    return () => {
      cancelled = true
    }
  }, [entry.outputPath])

  const copyLink = async () => {
    await window.api.system.writeClipboard(entry.url)
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

  return (
    <div className="fade-up flex items-center gap-3.5 surface-card rounded-[11px] px-3.5 py-2.5 mb-2 hover:border-line-strong transition-colors">
      <div className="relative w-[76px] h-[43px] rounded-lg overflow-hidden shrink-0 bg-black border border-line">
        {entry.thumbnail && !thumbFailed ? (
          <img
            src={entry.thumbnail}
            alt=""
            onError={() => setThumbFailed(true)}
            referrerPolicy="no-referrer"
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full grid place-items-center">
            <VideoIcon className="w-3.5 h-3.5 text-faint opacity-50" />
          </div>
        )}
      </div>

      <div className="flex-1 min-w-0">
        <h5 className="text-[13px] font-semibold truncate" title={entry.title}>
          {entry.title}
        </h5>
        <div className="mt-1 flex items-center gap-[7px] text-[11.5px] text-faint flex-wrap">
          <span className="truncate max-w-[160px]">{entry.uploader ?? hostOf(entry.url)}</span>
          <Dot />
          <span className="tabular-nums">{formatWhen(entry.completedAt)}</span>
          {entry.duration !== null && (
            <>
              <Dot />
              <span className="tabular-nums">{formatDuration(entry.duration)}</span>
            </>
          )}
          <span className="px-1.5 py-0.5 rounded-md bg-white/[0.06] border border-line text-[10.5px]">
            {entry.selectionLabel}
          </span>
          {entry.categoryName && (
            <span
              className="px-1.5 py-0.5 rounded-md text-[10.5px]"
              style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
            >
              {entry.categoryName}
            </span>
          )}
          {/* Only claim the file is gone when we actually checked a path. */}
          {entry.outputPath !== null && exists === false && (
            <span className="text-warn/80">file moved or deleted</span>
          )}
        </div>
      </div>

      <div className="text-[12px] text-muted tabular-nums w-[70px] text-right shrink-0">
        {entry.filesize !== null ? formatBytes(entry.filesize) : '—'}
      </div>

      <div className="flex gap-1.5 shrink-0">
        <IconButton title={copied ? 'Copied' : 'Copy link'} onClick={copyLink}>
          {copied ? (
            <span style={{ color: 'var(--accent)' }}>
              <CheckIcon />
            </span>
          ) : (
            <CopyIcon />
          )}
        </IconButton>

        {exists && entry.outputPath && (
          <IconButton
            title="Show in folder"
            onClick={() => window.api.system.showInFolder(entry.outputPath!)}
          >
            <FolderIcon />
          </IconButton>
        )}

        <IconButton title="Download again" onClick={() => openSheet(entry.url)}>
          <DownloadIcon />
        </IconButton>

        <IconButton
          danger
          title="Remove from history"
          onClick={() =>
            confirmAction({
              title: 'Remove from history?',
              message:
                'The record is deleted permanently. The downloaded file itself is left alone.',
              onConfirm: () => window.api.history.remove(entry.id)
            })
          }
        >
          <TrashIcon />
        </IconButton>
      </div>
    </div>
  )
}

function Dot() {
  return <span className="w-[3px] h-[3px] rounded-full bg-faint shrink-0" />
}
