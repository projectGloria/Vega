import { useState } from 'react'
import type { QueueItem } from '@shared/types'
import { formatBytes, formatDuration, formatEta, formatSpeed, hostOf } from '../lib/format'
import { confirmAction } from './ConfirmDialog'
import {
  AlertIcon,
  ChevronIcon,
  CloseIcon,
  FolderIcon,
  PauseIcon,
  PlayIcon,
  RetryIcon,
  TrashIcon,
  VideoIcon
} from './Icons'

const STATUS_LABEL: Record<QueueItem['status'], string> = {
  queued: 'Queued',
  probing: 'Reading…',
  downloading: 'Downloading',
  merging: 'Processing',
  paused: 'Paused',
  completed: 'Done',
  failed: 'Failed',
  canceled: 'Canceled'
}

export function selectionLabel(item: QueueItem): string {
  switch (item.selection.mode) {
    case 'best':
      return 'BEST'
    case 'quality':
      return item.selection.height + 'P'
    case 'format':
      return 'FMT ' + item.selection.formatId
    case 'audio':
      return item.selection.codec.toUpperCase()
  }
}

export default function DownloadCard({ item, index }: { item: QueueItem; index?: number }) {
  const [logOpen, setLogOpen] = useState(false)
  const [log, setLog] = useState<string[]>([])

  const active = item.status === 'downloading' || item.status === 'merging'
  const paused = item.status === 'paused'
  const failed = item.status === 'failed'
  const canceled = item.status === 'canceled'
  const isAudio = item.selection.mode === 'audio'

  // A stopped download should still say where it stopped. Losing the progress
  // readout the moment you pause is exactly when you most want to see it.
  const showProgress = active || ((paused || canceled || failed) && item.percent !== null)

  const remainingBytes =
    item.totalBytes !== null && item.downloadedBytes !== null
      ? Math.max(0, item.totalBytes - item.downloadedBytes)
      : null

  const toggleLog = async () => {
    if (!logOpen) setLog(await window.api.queue.getLog(item.id))
    setLogOpen(!logOpen)
  }

  return (
    <div className="fade-up surface-card rounded-card mb-2.5 hover:border-line-strong transition-colors overflow-hidden">
      <div className="flex items-center gap-[15px] p-3 pr-4">
        {index !== undefined && (
          <span className="shrink-0 w-[26px] h-[26px] rounded-lg bg-white/5 border border-line grid place-items-center text-[11px] font-bold text-faint tabular-nums">
            {index}
          </span>
        )}

        <Thumbnail item={item} />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2.5 mb-0.5">
            <h4 className="text-[13.5px] font-semibold truncate" title={item.title}>
              {item.title}
            </h4>
            <span
              className="shrink-0 text-[10px] font-bold tracking-[0.4px] px-[7px] py-[2.5px] rounded-[5px] border"
              style={
                isAudio
                  ? {
                      color: 'var(--color-warn)',
                      background: 'rgba(251,191,36,0.1)',
                      borderColor: 'rgba(251,191,36,0.25)'
                    }
                  : {
                      color: 'var(--accent)',
                      background: 'var(--accent-soft)',
                      borderColor: 'var(--accent-line)'
                    }
              }
            >
              {selectionLabel(item)}
            </span>
          </div>

          <div className="flex items-center gap-[7px] text-[11.5px] text-faint mb-2">
            <span className="truncate max-w-[180px]">{item.uploader ?? hostOf(item.url)}</span>
            {item.totalBytes !== null && (
              <>
                <Dot />
                <span className="tabular-nums">{formatBytes(item.totalBytes)}</span>
              </>
            )}
            {!showProgress && (
              <>
                <Dot />
                <span className={failed ? 'text-err/80' : undefined}>
                  {STATUS_LABEL[item.status]}
                </span>
              </>
            )}
          </div>

          {showProgress && (
            <>
              <ProgressBar percent={item.percent} live={active && !paused} />

              <div className="mt-2 flex items-center gap-2 text-[11.5px] text-faint tabular-nums">
                {item.status === 'merging' ? (
                  <span style={{ color: 'var(--accent)' }} className="font-semibold">
                    Merging and finishing up…
                  </span>
                ) : (
                  <>
                    <span
                      className="font-semibold"
                      style={{ color: paused ? 'var(--color-warn)' : 'var(--accent)' }}
                    >
                      {paused
                        ? 'Paused'
                        : canceled
                          ? 'Canceled'
                          : failed
                            ? 'Failed'
                            : item.speed
                              ? formatSpeed(item.speed)
                              : 'Starting…'}
                    </span>
                    <Dot />
                    {/* While stopped, "how much is left" is the useful number;
                        speed and ETA are meaningless with nothing running. */}
                    <span>
                      {active && item.eta !== null
                        ? formatEta(item.eta)
                        : remainingBytes !== null
                          ? formatBytes(remainingBytes) + ' left'
                          : '—'}
                    </span>
                  </>
                )}
                {item.percent !== null && (
                  <span className="ml-auto text-ink font-semibold">
                    {Math.floor(item.percent)}%
                  </span>
                )}
              </div>
            </>
          )}

          {/* A failed item can also be showing a bar; its reason still needs a
              line of its own rather than being hidden behind the progress. */}
          {failed && item.error && (
            <p className="mt-1.5 text-[11.5px] text-err/80 leading-snug">{item.error}</p>
          )}
          {item.status === 'queued' && item.error && (
            <p className="mt-1.5 text-[11.5px] text-warn/80 leading-snug">{item.error}</p>
          )}
        </div>

        <div className="flex gap-1.5 shrink-0">
          {item.status === 'completed' && item.outputPath && (
            <IconButton
              title="Show in folder"
              onClick={() => window.api.system.showInFolder(item.outputPath!)}
            >
              <FolderIcon />
            </IconButton>
          )}

          {active && (
            <IconButton title="Pause" onClick={() => window.api.queue.pause(item.id)}>
              <PauseIcon />
            </IconButton>
          )}

          {/* Only a paused item can be resumed. A queued one is already waiting
              its turn, so a play button there would do nothing at all. */}
          {paused && (
            <IconButton title="Resume" onClick={() => window.api.queue.resume(item.id)}>
              <PlayIcon />
            </IconButton>
          )}

          {(failed || canceled) && (
            <IconButton title="Try again" onClick={() => window.api.queue.retry(item.id)}>
              <RetryIcon />
            </IconButton>
          )}

          <IconButton title="Details" onClick={toggleLog}>
            <ChevronIcon className={'w-[13px] h-[13px] transition-transform duration-150 ' + (logOpen ? 'rotate-180' : '')} />
          </IconButton>

          {active || item.status === 'queued' || paused ? (
            <IconButton
              danger
              title="Cancel"
              onClick={() =>
                confirmAction({
                  title: 'Cancel this download?',
                  message: 'Progress so far is kept, so you can start it again later.',
                  confirmLabel: 'Cancel download',
                  onConfirm: () => window.api.queue.cancel(item.id)
                })
              }
            >
              <CloseIcon />
            </IconButton>
          ) : (
            <IconButton
              danger
              title="Remove from list"
              onClick={() =>
                confirmAction({
                  title: 'Remove from the list?',
                  message:
                    'This removes the entry from the queue. Any file already downloaded stays on disk.',
                  onConfirm: () => window.api.queue.remove(item.id)
                })
              }
            >
              <TrashIcon />
            </IconButton>
          )}
        </div>
      </div>

      {logOpen && (
        <div className="border-t border-line bg-black/30">
          {item.outputPath && (
            <button
              onClick={() => window.api.system.openPath(item.outputPath!)}
              className="w-full text-left px-4 py-2 text-[11.5px] text-muted hover:text-ink border-b border-line truncate transition-colors"
              title={item.outputPath}
            >
              {item.outputPath}
            </button>
          )}
          <pre className="px-4 py-2.5 text-[11px] leading-relaxed text-faint font-mono max-h-44 overflow-auto whitespace-pre-wrap break-all">
            {log.length > 0 ? log.join('\n') : 'No output yet.'}
          </pre>
        </div>
      )}
    </div>
  )
}

function Dot() {
  return <span className="w-[3px] h-[3px] rounded-full bg-faint shrink-0" />
}

export function ProgressBar({ percent, live }: { percent: number | null; live: boolean }) {
  return (
    <div className="h-[5px] rounded-full bg-white/[0.07] overflow-hidden relative">
      {percent === null ? (
        <div
          className="h-full w-1/4 rounded-full"
          style={{ background: 'var(--grad)', animation: 'indeterminate 1.2s ease-in-out infinite' }}
        />
      ) : (
        <div
          className="h-full rounded-full relative overflow-hidden transition-[width] duration-500 ease-linear"
          style={{ width: percent + '%', background: 'var(--grad)' }}
        >
          {/* The travelling sheen is what separates "downloading" from
              "stalled at 41%" at a glance, so it is only drawn when live. */}
          {live && (
            <span
              className="absolute inset-0"
              style={{
                background:
                  'linear-gradient(90deg, transparent, rgba(255,255,255,0.35), transparent)',
                transform: 'translateX(-100%)',
                animation: 'shimmer 1.6s infinite'
              }}
            />
          )}
        </div>
      )}
    </div>
  )
}

function Thumbnail({ item }: { item: QueueItem }) {
  const [failed, setFailed] = useState(false)

  return (
    <div className="relative w-[104px] h-[58px] rounded-[9px] overflow-hidden shrink-0 bg-black border border-line">
      {item.thumbnail && !failed ? (
        <img
          src={item.thumbnail}
          alt=""
          onError={() => setFailed(true)}
          referrerPolicy="no-referrer"
          className="w-full h-full object-cover"
        />
      ) : (
        <div className="w-full h-full grid place-items-center">
          <VideoIcon className="w-4 h-4 text-faint opacity-50" />
        </div>
      )}

      {item.status === 'failed' && (
        <span className="absolute inset-0 grid place-items-center bg-black/50">
          <AlertIcon className="w-5 h-5 text-err" />
        </span>
      )}

      {item.duration !== null && item.status !== 'failed' && (
        <span className="absolute right-1 bottom-1 px-[5px] py-0.5 rounded bg-black/75 text-[10px] font-semibold tabular-nums">
          {formatDuration(item.duration)}
        </span>
      )}
    </div>
  )
}

export function IconButton({
  children,
  title,
  onClick,
  danger
}: {
  children: React.ReactNode
  title: string
  onClick(): void
  danger?: boolean
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      className={
        'w-8 h-8 rounded-lg border border-line bg-white/[0.04] text-muted grid place-items-center transition-all duration-150 shrink-0 ' +
        (danger
          ? 'hover:bg-err/12 hover:border-err/35 hover:text-err'
          : 'hover:bg-white/10 hover:text-ink')
      }
    >
      {/* A descendant selector, not a child one: callers wrap icons in a span
          to tint them, and a child selector silently misses those. */}
      <span className="w-[13px] h-[13px] grid place-items-center [&_svg]:w-[13px] [&_svg]:h-[13px]">
        {children}
      </span>
    </button>
  )
}
