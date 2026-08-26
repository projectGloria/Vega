import { useMemo } from 'react'
import { useApp } from '../store/app'
import DownloadCard from './DownloadCard'
import { EmptyState, PageHead } from './Layout'
import { PlayIcon, QueueIcon } from './Icons'

/**
 * What is waiting rather than what is running.
 *
 * Nothing here needs starting by hand — the queue pulls the next item the
 * moment a slot frees — so the only action is resuming what was paused.
 */
export default function QueueView() {
  const queue = useApp((s) => s.queue)
  const concurrency = useApp((s) => s.settings?.concurrency ?? 3)

  const waiting = useMemo(
    () => queue.filter((i) => i.status === 'queued' || i.status === 'paused'),
    [queue]
  )

  const paused = waiting.filter((i) => i.status === 'paused')

  return (
    <>
      <PageHead
        title="Queue"
        subtitle={
          'Up next in line. Downloads start on their own as slots free up — ' +
          concurrency +
          ' run at a time.'
        }
      >
        {paused.length > 0 && (
          <button
            onClick={() => paused.forEach((item) => window.api.queue.resume(item.id))}
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-[10px] text-[13px] font-semibold
                       border border-line bg-white/5 text-muted hover:bg-white/[0.09] hover:text-ink transition-all"
          >
            <PlayIcon className="w-[15px] h-[15px]" />
            Resume all
          </button>
        )}
      </PageHead>

      {waiting.length > 0 ? (
        waiting.map((item, index) => (
          <DownloadCard key={item.id} item={item} index={index + 1} />
        ))
      ) : (
        <EmptyState icon={<QueueIcon className="w-6 h-6" />} title="Queue is empty">
          Links you add beyond the {concurrency} running slots wait here, and start as soon as one
          of those finishes.
        </EmptyState>
      )}
    </>
  )
}
