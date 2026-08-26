import { useMemo, useState } from 'react'
import type { HistoryEntry } from '@shared/types'
import { useApp } from '../store/app'
import { formatBytes, formatDuration, formatSpeed, hostOf, startOfToday } from '../lib/format'
import UrlBar from './UrlBar'
import DownloadCard, { IconButton } from './DownloadCard'
import { Empty, LinkButton, PageHead, SectionHead, StatPill } from './Layout'
import { confirmAction } from './ConfirmDialog'
import { CheckIcon, FolderIcon, TrashIcon, VideoIcon } from './Icons'

export default function DownloadsView() {
  const queue = useApp((s) => s.queue)
  const history = useApp((s) => s.history)
  const setView = useApp((s) => s.setView)

  const { active, stopped } = useMemo(
    () => ({
      // Queued items live in the Queue view; this one is about work in flight.
      active: queue.filter(
        (i) =>
          i.status === 'downloading' ||
          i.status === 'merging' ||
          i.status === 'probing' ||
          i.status === 'paused'
      ),
      stopped: queue.filter((i) => i.status === 'failed' || i.status === 'canceled')
    }),
    [queue]
  )

  const running = active.filter((i) => i.status === 'downloading' || i.status === 'merging')
  const totalSpeed = running.reduce((sum, i) => sum + (i.speed ?? 0), 0)

  const doneToday = useMemo(() => {
    const cutoff = startOfToday()
    return history.filter((entry) => entry.completedAt >= cutoff)
  }, [history])

  return (
    <>
      <PageHead
        title="Downloads"
        subtitle="Paste a link below to grab any video in one click."
      >
        <div className="flex gap-2 flex-wrap">
          <StatPill tone="accent">
            <b className="text-ink font-semibold tabular-nums">{running.length}</b>
            &nbsp;active
          </StatPill>
          <StatPill tone="warn">
            <b className="text-ink font-semibold tabular-nums">
              {totalSpeed > 0 ? formatSpeed(totalSpeed) : '0 KB/s'}
            </b>
          </StatPill>
          <StatPill tone="ok">
            <b className="text-ink font-semibold tabular-nums">{doneToday.length}</b>
            &nbsp;done today
          </StatPill>
        </div>
      </PageHead>

      <UrlBar />

      <SectionHead title="Active" count={active.length} first />
      {active.length > 0 ? (
        active.map((item) => <DownloadCard key={item.id} item={item} />)
      ) : (
        <Empty>No active downloads — paste a link above to start one.</Empty>
      )}

      {stopped.length > 0 && (
        <>
          <SectionHead
            title="Stopped"
            count={stopped.length}
            action={
              <LinkButton
                danger
                onClick={() =>
                  confirmAction({
                    title: 'Clear stopped downloads?',
                    message:
                      'The ' +
                      stopped.length +
                      ' stopped entries are removed from this list. Partly downloaded files stay on disk.',
                    confirmLabel: 'Clear',
                    onConfirm: () => window.api.queue.clearFinished()
                  })
                }
              >
                Clear all
              </LinkButton>
            }
          />
          {stopped.map((item) => (
            <DownloadCard key={item.id} item={item} />
          ))}
        </>
      )}

      <SectionHead
        title="Completed today"
        count={doneToday.length}
        action={<LinkButton onClick={() => setView('history')}>See all history</LinkButton>}
      />
      {doneToday.length > 0 ? (
        doneToday.map((entry) => <CompletedCard key={entry.id} entry={entry} />)
      ) : (
        <Empty>Nothing finished today yet.</Empty>
      )}
    </>
  )
}

/**
 * A finished download, read back out of history.
 *
 * The queue only holds work in progress — an item leaves it the moment it is
 * safely recorded — so this section is a view onto history rather than a second
 * list that could drift out of step with it.
 */
function CompletedCard({ entry }: { entry: HistoryEntry }) {
  const [thumbFailed, setThumbFailed] = useState(false)

  return (
    <div className="fade-up surface-card rounded-card mb-2.5 hover:border-line-strong transition-colors">
      <div className="flex items-center gap-[15px] p-3 pr-4">
        <div className="relative w-[104px] h-[58px] rounded-[9px] overflow-hidden shrink-0 bg-black border border-line">
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
              <VideoIcon className="w-4 h-4 text-faint opacity-50" />
            </div>
          )}
          <span className="absolute inset-0 grid place-items-center bg-black/45">
            <CheckIcon className="w-5 h-5 text-ok" />
          </span>
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2.5 mb-0.5">
            <h4 className="text-[13.5px] font-semibold truncate" title={entry.title}>
              {entry.title}
            </h4>
            <span
              className="shrink-0 text-[10px] font-bold tracking-[0.4px] px-[7px] py-[2.5px] rounded-[5px] border"
              style={{
                color: 'var(--accent)',
                background: 'var(--accent-soft)',
                borderColor: 'var(--accent-line)'
              }}
            >
              {entry.selectionLabel.toUpperCase()}
            </span>
          </div>
          <div className="flex items-center gap-[7px] text-[11.5px] text-faint flex-wrap">
            <span className="truncate max-w-[180px]">{entry.uploader ?? hostOf(entry.url)}</span>
            {entry.duration !== null && (
              <>
                <Dot />
                <span className="tabular-nums">{formatDuration(entry.duration)}</span>
              </>
            )}
            {entry.filesize !== null && (
              <>
                <Dot />
                <span className="tabular-nums">{formatBytes(entry.filesize)}</span>
              </>
            )}
            <Dot />
            <span style={{ color: 'var(--color-ok)' }}>Completed</span>
          </div>
        </div>

        <div className="flex gap-1.5 shrink-0">
          {entry.outputPath && (
            <IconButton
              title="Show in folder"
              onClick={() => window.api.system.showInFolder(entry.outputPath!)}
            >
              <FolderIcon />
            </IconButton>
          )}
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
    </div>
  )
}

function Dot() {
  return <span className="w-[3px] h-[3px] rounded-full bg-faint shrink-0" />
}
