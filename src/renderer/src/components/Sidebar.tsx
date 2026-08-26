import { useEffect, useState } from 'react'
import type { DiskSpace } from '@shared/types'
import type { View } from '../store/app'
import { useApp } from '../store/app'
import { formatBytes } from '../lib/format'
import { ClockIcon, DownloadIcon, PasteIcon, QueueIcon, SettingsIcon } from './Icons'

interface NavItem {
  id: View
  label: string
  icon: React.ReactNode
  badge?: number
  /** Tints the badge, for counts that mean "something is happening now". */
  hot?: boolean
}

/** Free space moves slowly; polling harder than this would be pointless. */
const DISK_POLL_MS = 60_000

export default function Sidebar() {
  const view = useApp((s) => s.view)
  const setView = useApp((s) => s.setView)
  const queue = useApp((s) => s.queue)
  const inbox = useApp((s) => s.inbox)

  const running = queue.filter(
    (i) => i.status === 'downloading' || i.status === 'merging'
  ).length
  const waiting = queue.filter((i) => i.status === 'queued' || i.status === 'paused').length

  const items: NavItem[] = [
    {
      id: 'downloads',
      label: 'Downloads',
      icon: <DownloadIcon className="w-[17px] h-[17px]" />,
      badge: running,
      hot: true
    },
    {
      id: 'queue',
      label: 'Queue',
      icon: <QueueIcon className="w-[17px] h-[17px]" />,
      badge: waiting
    },
    {
      id: 'clipboard',
      label: 'Clipboard',
      icon: <PasteIcon className="w-[17px] h-[17px]" />,
      badge: inbox.length
    },
    { id: 'history', label: 'History', icon: <ClockIcon className="w-[17px] h-[17px]" /> },
    { id: 'settings', label: 'Settings', icon: <SettingsIcon className="w-[17px] h-[17px]" /> }
  ]

  return (
    <nav className="sidebar shrink-0 flex flex-col gap-1 border-r border-line bg-white/[0.012]">
      {items.map((item) => (
        <NavButton
          key={item.id}
          item={item}
          active={view === item.id}
          onClick={() => setView(item.id)}
        />
      ))}

      <div className="flex-1" />

      <EngineCard />
      <StorageCard />
    </nav>
  )
}

function NavButton({
  item,
  active,
  onClick
}: {
  item: NavItem
  active: boolean
  onClick(): void
}) {
  return (
    <button
      onClick={onClick}
      title={item.label}
      className={
        'sidebar-item relative w-full flex items-center gap-[11px] rounded-[9px] text-[13.5px] font-medium text-left transition-all duration-150 ' +
        (active ? 'text-ink' : 'text-muted hover:text-ink hover:bg-white/5')
      }
      style={active ? { background: 'var(--accent-soft)' } : undefined}
    >
      {active && (
        <span
          className="sidebar-rail absolute top-2 bottom-2 w-[3px] rounded-full"
          style={{ background: 'var(--grad)' }}
        />
      )}
      <span className="shrink-0" style={active ? { color: 'var(--accent)' } : undefined}>
        {item.icon}
      </span>
      <span className="sidebar-wide-only flex-1 truncate">{item.label}</span>
      {item.badge !== undefined && item.badge > 0 && (
        <em
          className="sidebar-wide-only not-italic shrink-0 min-w-[20px] px-[7px] py-0.5 rounded-full text-[10.5px] font-semibold text-center tabular-nums"
          style={
            item.hot
              ? { background: 'var(--accent-soft)', color: 'var(--accent)' }
              : { background: 'rgba(255,255,255,0.07)', color: 'var(--color-muted)' }
          }
        >
          {item.badge > 99 ? '99+' : item.badge}
        </em>
      )}
    </button>
  )
}

function EngineCard() {
  const versions = useApp((s) => s.versions)
  const ready = versions.ytdlp !== null

  return (
    <div className="sidebar-wide-only surface-card rounded-[11px] p-3 mt-2">
      <div className="flex items-center gap-2 text-[12px] font-semibold">
        <span
          className="w-[7px] h-[7px] rounded-full shrink-0"
          style={
            ready
              ? { background: 'var(--color-ok)', animation: 'pulse-ring 2s infinite' }
              : { background: 'var(--color-warn)' }
          }
        />
        {ready ? 'Engine ready' : 'Engine missing'}
      </div>
      <div className="text-[11px] text-faint mt-1.5 leading-relaxed">
        {ready ? (
          <>
            yt-dlp {versions.ytdlp}
            <br />
            {versions.ffmpeg ? 'ffmpeg ' + versions.ffmpeg : 'ffmpeg not detected'}
          </>
        ) : (
          'yt-dlp did not report a version. Downloads will fail until it is reinstalled.'
        )}
      </div>
    </div>
  )
}

/**
 * Headroom on the volume the download folder actually lives on — which is not
 * necessarily the one the app is installed on.
 */
function StorageCard() {
  const [disk, setDisk] = useState<DiskSpace | null>(null)
  const [checked, setChecked] = useState(false)
  const downloadDir = useApp((s) => s.settings?.downloadDir)
  const history = useApp((s) => s.history.length)

  useEffect(() => {
    let cancelled = false

    const read = () =>
      window.api.system.diskSpace().then((value) => {
        if (cancelled) return
        setDisk(value)
        setChecked(true)
      })

    void read()
    const timer = setInterval(read, DISK_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
    // A finished download and a moved folder both change the answer.
  }, [downloadDir, history])

  // Nothing at all beats a bar that is lying about a drive we could not read.
  if (!checked || !disk || disk.total <= 0) return null

  const usedPercent = Math.min(100, Math.max(0, ((disk.total - disk.free) / disk.total) * 100))

  return (
    <div className="sidebar-wide-only surface-card rounded-[11px] p-3 mt-2">
      <div className="flex justify-between text-[11.5px] text-muted mb-2">
        <span>Storage</span>
        <b className="text-ink font-semibold tabular-nums">{Math.round(usedPercent)}%</b>
      </div>
      <div className="h-[5px] rounded-full bg-white/[0.07] overflow-hidden">
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{ width: usedPercent + '%', background: 'var(--grad)' }}
        />
      </div>
      <div className="text-[11px] text-faint mt-2 tabular-nums">
        {formatBytes(disk.free)} free of {formatBytes(disk.total)}
      </div>
    </div>
  )
}
