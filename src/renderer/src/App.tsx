import { useEffect, useRef } from 'react'
import { useApp } from './store/app'
import { toast } from './store/toasts'
import TitleBar from './components/TitleBar'
import Sidebar from './components/Sidebar'
import DownloadsView from './components/DownloadsView'
import QueueView from './components/QueueView'
import ClipboardView from './components/ClipboardView'
import HistoryView from './components/HistoryView'
import SettingsView from './components/SettingsView'
import DownloadSheet from './components/DownloadSheet'
import ConfirmDialog from './components/ConfirmDialog'
import Toasts from './components/Toasts'
import { useLinkDrop } from './hooks/useLinkDrop'
import { DownloadIcon } from './components/Icons'

export default function App() {
  const dragging = useLinkDrop()
  const loadSettings = useApp((s) => s.loadSettings)
  const loadInboxAndHistory = useApp((s) => s.loadInboxAndHistory)
  const setQueue = useApp((s) => s.setQueue)
  const patchQueueItem = useApp((s) => s.patchQueueItem)
  const setInbox = useApp((s) => s.setInbox)
  const setHistory = useApp((s) => s.setHistory)
  const view = useApp((s) => s.view)

  useEffect(() => {
    void loadSettings()
    void loadInboxAndHistory()
    void window.api.queue.list().then(setQueue)

    // Full list updates on state changes; per-item events carry live progress.
    const offItems = window.api.queue.onUpdate(setQueue)
    const offProgress = window.api.queue.onItemProgress(patchQueueItem)
    const offInbox = window.api.clipboardInbox.onUpdate(setInbox)
    const offHistory = window.api.history.onUpdate(setHistory)

    return () => {
      offItems()
      offProgress()
      offInbox()
      offHistory()
    }
  }, [loadSettings, loadInboxAndHistory, setQueue, patchQueueItem, setInbox, setHistory])

  useDownloadNotices()

  return (
    <div className="h-full flex flex-col app-bg overflow-hidden">
      <span
        className="bloom w-[520px] h-[520px] -top-40 -left-32 opacity-[0.07]"
        style={{ background: 'var(--accent)' }}
      />
      <span
        className="bloom w-[560px] h-[560px] -bottom-52 -right-36 opacity-[0.08]"
        style={{ background: 'var(--accent-2)' }}
      />

      <TitleBar />

      <div className="flex-1 flex min-h-0">
        <Sidebar />

        <main className="flex-1 min-w-0 overflow-y-auto px-7 py-6">
          {/* Remounting on a view change is what replays the entry animation,
              which is the whole point of the transition. */}
          <div key={view} className="fade-up max-w-[1000px]">
            {view === 'downloads' && <DownloadsView />}
            {view === 'queue' && <QueueView />}
            {view === 'clipboard' && <ClipboardView />}
            {view === 'history' && <HistoryView />}
            {view === 'settings' && <SettingsView />}
          </div>
        </main>
      </div>

      <DownloadSheet />
      <ConfirmDialog />
      <Toasts />

      {dragging && (
        <div className="fixed inset-0 top-[46px] z-[60] grid place-items-center pointer-events-none">
          <div
            className="absolute inset-3 rounded-2xl border-2 border-dashed bg-ground/80 backdrop-blur-sm"
            style={{ borderColor: 'var(--accent-line)' }}
          />
          <div className="relative flex flex-col items-center gap-3">
            <div
              className="w-14 h-14 rounded-2xl grid place-items-center"
              style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
            >
              <DownloadIcon className="w-6 h-6" />
            </div>
            <p className="text-[14px] font-medium text-ink">Drop the link to load it</p>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Announces the things that finish while you are looking somewhere else.
 *
 * A completed download leaves the queue the moment it is recorded, so history
 * — not the queue — is what says "this one is done". Failures never reach
 * history, so those are watched on the queue instead.
 */
function useDownloadNotices(): void {
  const history = useApp((s) => s.history)
  const queue = useApp((s) => s.queue)

  const knownHistory = useRef<Set<string> | null>(null)
  const announcedFailures = useRef(new Set<string>())

  useEffect(() => {
    const ids = new Set(history.map((entry) => entry.id))

    // The first load is not news: everything in it was downloaded before this
    // window ever opened, and toasting all of it would be absurd.
    if (knownHistory.current === null) {
      knownHistory.current = ids
      return
    }

    for (const entry of history) {
      if (!knownHistory.current.has(entry.id)) {
        toast('success', 'Download complete', entry.title)
      }
    }
    knownHistory.current = ids
  }, [history])

  useEffect(() => {
    for (const item of queue) {
      if (item.status === 'failed' && !announcedFailures.current.has(item.id)) {
        announcedFailures.current.add(item.id)
        toast('danger', 'Download failed', item.error ?? item.title)
      }
      // Retrying clears the way for a second notice if it fails again.
      if (item.status !== 'failed') announcedFailures.current.delete(item.id)
    }
  }, [queue])
}
