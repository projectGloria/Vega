import { useEffect, useState } from 'react'
import { BrandMark, CloseGlyph, MaximizeGlyph, MinimizeGlyph } from './Icons'

export default function TitleBar() {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => window.api.window.onMaximizeChange(setMaximized), [])

  return (
    <header className="drag h-[46px] shrink-0 flex items-center gap-3 pl-4 pr-2.5 border-b border-line bg-white/[0.015] relative z-30">
      <div className="flex items-center gap-2.5">
        <BrandMark className="w-5 h-5 drop-shadow-[0_0_8px_var(--accent-line)]" />
        <span className="font-display text-[16px] font-bold tracking-[0.4px]">Vega</span>
        <span
          className="text-[10px] font-semibold px-[7px] py-0.5 rounded-full tracking-[0.5px] border"
          style={{
            color: 'var(--accent)',
            background: 'var(--accent-soft)',
            borderColor: 'var(--accent-line)'
          }}
        >
          v1.0
        </span>
      </div>

      <div className="flex-1 text-center text-[12px] text-faint tracking-[0.3px] truncate max-[680px]:hidden">
        Video Downloader — Windows
      </div>

      <div className="no-drag flex gap-0.5">
        <WindowButton label="Minimize" onClick={() => window.api.window.minimize()}>
          <MinimizeGlyph />
        </WindowButton>
        <WindowButton
          label={maximized ? 'Restore' : 'Maximize'}
          onClick={() => window.api.window.toggleMaximize()}
        >
          <MaximizeGlyph maximized={maximized} />
        </WindowButton>
        <WindowButton label="Close" onClick={() => window.api.window.close()} close>
          <CloseGlyph />
        </WindowButton>
      </div>
    </header>
  )
}

function WindowButton({
  children,
  label,
  onClick,
  close
}: {
  children: React.ReactNode
  label: string
  onClick(): void
  close?: boolean
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className={
        'w-[42px] h-8 rounded-lg grid place-items-center text-muted transition-colors ' +
        (close ? 'hover:bg-[#e81123] hover:text-white' : 'hover:bg-white/[0.07] hover:text-ink')
      }
    >
      {children}
    </button>
  )
}
