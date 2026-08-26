import { useState } from 'react'
import type { ClipboardEntry } from '@shared/types'
import { formatBytes, formatDuration, formatWhen, hostOf } from '../lib/format'
import { useApp } from '../store/app'
import { toast } from '../store/toasts'
import CategoryPicker from './CategoryPicker'
import { confirmAction } from './ConfirmDialog'
import { EmptyState, LinkButton, PageHead } from './Layout'
import { IconButton } from './DownloadCard'
import {
  AlertIcon,
  CopyIcon,
  DownloadIcon,
  PasteIcon,
  QueueIcon,
  RetryIcon,
  TrashIcon,
  VideoIcon
} from './Icons'

/**
 * Links caught from the clipboard while the app sat in the tray. Each one is
 * probed in the background, so its thumbnail, duration and sizes are already
 * here by the time the window is opened.
 */
export default function ClipboardView() {
  const inbox = useApp((s) => s.inbox)

  return (
    <>
      <PageHead
        title="Clipboard"
        subtitle="Links you copied while Vega was running, already looked up."
      >
        {inbox.length > 0 && (
          <LinkButton
            danger
            onClick={() =>
              confirmAction({
                title: 'Clear captured links?',
                message:
                  'All ' +
                  inbox.length +
                  ' captured links are removed from this list. Nothing already downloaded is affected.',
                confirmLabel: 'Clear all',
                onConfirm: () => window.api.clipboardInbox.clear()
              })
            }
          >
            Clear all
          </LinkButton>
        )}
      </PageHead>

      {inbox.length === 0 ? (
        <EmptyInbox />
      ) : (
        <>
          <div className="mb-4">
            <CategoryPicker />
          </div>
          {inbox.map((entry) => (
            <InboxRow key={entry.id} entry={entry} />
          ))}
        </>
      )}
    </>
  )
}

function EmptyInbox() {
  const watching = useApp((s) => s.settings?.watchClipboard ?? true)

  return (
    <EmptyState icon={<PasteIcon className="w-6 h-6" />} title="Nothing captured yet">
      {watching
        ? 'Copy a video link anywhere and it shows up here, already looked up — even with this window closed.'
        : 'Clipboard watching is turned off. Enable "Offer links you copy" in Settings to collect links here.'}
    </EmptyState>
  )
}

function InboxRow({ entry }: { entry: ClipboardEntry }) {
  const settings = useApp((s) => s.settings)
  const enqueue = useApp((s) => s.enqueue)
  const activeCategoryId = useApp((s) => s.activeCategoryId)
  const openSheet = useApp((s) => s.openSheet)

  const [busy, setBusy] = useState(false)

  const downloadBest = async () => {
    setBusy(true)
    try {
      await enqueue([
        {
          url: entry.url,
          title: entry.title ?? entry.url,
          uploader: entry.uploader,
          thumbnail: entry.thumbnail,
          duration: entry.duration,
          selection: { mode: 'best' },
          categoryId: activeCategoryId,
          subtitleLangs: settings?.subtitleLangs,
          embedSubs: settings?.embedSubs ?? false,
          embedThumbnail: settings?.embedThumbnail ?? true,
          embedMetadata: settings?.embedMetadata ?? true,
          sponsorblock: settings?.sponsorblock ?? false
        }
      ])
      await window.api.clipboardInbox.remove(entry.id)
      toast('info', 'Download started', entry.title ?? entry.url)
    } catch (err) {
      toast(
        'danger',
        'Could not start that download',
        err instanceof Error ? err.message : undefined
      )
    } finally {
      setBusy(false)
    }
  }

  const copyLink = async () => {
    await window.api.system.writeClipboard(entry.url)
    toast('success', 'Link copied', entry.url)
  }

  return (
    <div className="fade-up surface-card rounded-card mb-2.5 hover:border-line-strong transition-colors">
      <div className="flex items-center gap-[15px] p-3 pr-4">
        <Thumb entry={entry} />

        <div className="flex-1 min-w-0">
          {entry.status === 'pending' ? (
            <>
              <div className="h-3.5 w-2/3 rounded bg-white/[0.06] animate-pulse" />
              <div className="mt-2 h-3 w-1/3 rounded bg-white/[0.06] animate-pulse" />
              <p className="mt-2 text-[11.5px] text-faint truncate">Looking up…</p>
            </>
          ) : entry.status === 'error' ? (
            <>
              <p className="text-[13px] text-ink truncate" title={entry.url}>
                {entry.url}
              </p>
              <p className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-err/80">
                <AlertIcon className="w-3.5 h-3.5 shrink-0" />
                {entry.error ?? 'Could not read that link.'}
              </p>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2.5 mb-0.5">
                <h4 className="text-[13.5px] font-semibold truncate" title={entry.title ?? ''}>
                  {entry.title}
                </h4>
                {entry.isPlaylist && (
                  <span
                    className="shrink-0 text-[10px] font-bold tracking-[0.4px] px-[7px] py-[2.5px] rounded-[5px]"
                    style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
                  >
                    PLAYLIST
                  </span>
                )}
              </div>
              <div className="flex items-center gap-[7px] text-[11.5px] text-faint flex-wrap">
                <span className="truncate max-w-[170px]">
                  {entry.uploader ?? hostOf(entry.url)}
                </span>
                <Dot />
                <span className="tabular-nums">{formatWhen(entry.addedAt)}</span>
                {entry.duration !== null && (
                  <>
                    <Dot />
                    <span className="tabular-nums">{formatDuration(entry.duration)}</span>
                  </>
                )}
                {entry.qualities.length > 0 && (
                  <>
                    <Dot />
                    <span className="tabular-nums">up to {entry.qualities[0]}p</span>
                  </>
                )}
                {entry.bestSize !== null && (
                  <>
                    <Dot />
                    <span className="tabular-nums">≈ {formatBytes(entry.bestSize)}</span>
                  </>
                )}
              </div>
            </>
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {entry.status === 'ready' &&
            /*
             * Downloads pass --no-playlist, so a one-click "Best" on a playlist
             * would quietly fetch only its first video. A playlist has to be
             * opened and picked from instead.
             */
            (entry.isPlaylist ? (
              <button
                onClick={() => openSheet(entry.url)}
                className="px-3 py-1.5 rounded-lg text-[12.5px] font-semibold border border-line
                           text-muted hover:text-ink hover:border-line-strong transition-colors"
              >
                Open playlist
              </button>
            ) : (
              <>
                <button
                  onClick={downloadBest}
                  disabled={busy}
                  title="Download the best available quality"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12.5px] font-semibold
                             text-white transition-all hover:brightness-110 disabled:opacity-50"
                  style={{ background: 'var(--grad)' }}
                >
                  <DownloadIcon className="w-3.5 h-3.5" />
                  Best
                </button>
                <button
                  onClick={() => openSheet(entry.url)}
                  className="px-2.5 py-1.5 rounded-lg text-[12.5px] text-muted border border-line
                             hover:text-ink hover:border-line-strong transition-colors"
                  title="Choose a quality"
                >
                  Options
                </button>
              </>
            ))}

          {entry.status === 'error' && (
            <IconButton
              title="Try again"
              onClick={() => window.api.clipboardInbox.retry(entry.id)}
            >
              <RetryIcon />
            </IconButton>
          )}

          <IconButton title="Copy link" onClick={copyLink}>
            <CopyIcon />
          </IconButton>

          <IconButton
            danger
            title="Remove"
            onClick={() =>
              confirmAction({
                title: 'Remove this link?',
                message: 'It is taken off the captured list. You can always copy the link again.',
                onConfirm: () => window.api.clipboardInbox.remove(entry.id)
              })
            }
          >
            <TrashIcon />
          </IconButton>
        </div>
      </div>
    </div>
  )
}

function Thumb({ entry }: { entry: ClipboardEntry }) {
  const [failed, setFailed] = useState(false)

  return (
    <div className="relative w-[104px] h-[58px] rounded-[9px] overflow-hidden shrink-0 bg-black border border-line">
      {entry.thumbnail && !failed ? (
        <img
          src={entry.thumbnail}
          alt=""
          onError={() => setFailed(true)}
          referrerPolicy="no-referrer"
          className="w-full h-full object-cover"
        />
      ) : (
        <div className="w-full h-full grid place-items-center">
          {entry.status === 'pending' ? (
            <span
              className="w-4 h-4 rounded-full border-[1.5px]"
              style={{
                borderColor: 'var(--accent)',
                borderTopColor: 'transparent',
                animation: 'spin 700ms linear infinite'
              }}
            />
          ) : entry.isPlaylist ? (
            <QueueIcon className="w-4 h-4 text-faint opacity-50" />
          ) : (
            <VideoIcon className="w-4 h-4 text-faint opacity-50" />
          )}
        </div>
      )}
      {entry.duration !== null && (
        <span className="absolute right-1 bottom-1 px-[5px] py-0.5 rounded bg-black/75 text-[10px] font-semibold tabular-nums">
          {formatDuration(entry.duration)}
        </span>
      )}
    </div>
  )
}

function Dot() {
  return <span className="w-[3px] h-[3px] rounded-full bg-faint shrink-0" />
}
