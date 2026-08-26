/** The shared furniture every view is built out of: heading, section rules, empties. */

export function PageHead({
  title,
  subtitle,
  children
}: {
  title: string
  subtitle: string
  /** Pills, a search box, or an action — whatever sits opposite the heading. */
  children?: React.ReactNode
}) {
  return (
    <div className="flex items-end justify-between gap-4 flex-wrap mb-5">
      <div>
        <h1 className="font-display text-[23px] font-bold tracking-[0.2px]">{title}</h1>
        <p className="text-muted text-[12.5px] mt-1.5">{subtitle}</p>
      </div>
      {children}
    </div>
  )
}

export function StatPill({
  tone,
  children
}: {
  tone: 'accent' | 'ok' | 'warn'
  children: React.ReactNode
}) {
  const colors: Record<typeof tone, string> = {
    accent: 'var(--accent)',
    ok: 'var(--color-ok)',
    warn: 'var(--color-warn)'
  }

  return (
    <div className="flex items-center gap-[7px] surface-card rounded-full px-3.5 py-1.5 text-[12px] text-muted">
      <span
        className="w-1.5 h-1.5 rounded-full shrink-0"
        style={{
          background: colors[tone],
          boxShadow: tone === 'accent' ? '0 0 6px var(--accent)' : undefined
        }}
      />
      {children}
    </div>
  )
}

export function SectionHead({
  title,
  count,
  action,
  first
}: {
  title: string
  count?: number
  action?: React.ReactNode
  /** Skips the top margin for the first section under the page heading. */
  first?: boolean
}) {
  return (
    <div className={'flex items-center gap-2.5 mb-3 ' + (first ? '' : 'mt-6')}>
      <h3 className="text-[11.5px] font-semibold tracking-[1.4px] uppercase text-muted">
        {title}
      </h3>
      {count !== undefined && (
        <span
          className="text-[10.5px] font-bold px-2 py-0.5 rounded-full tabular-nums"
          style={{ color: 'var(--accent)', background: 'var(--accent-soft)' }}
        >
          {count}
        </span>
      )}
      <div className="flex-1" />
      {action}
    </div>
  )
}

export function LinkButton({
  children,
  onClick,
  danger
}: {
  children: React.ReactNode
  onClick(): void
  danger?: boolean
}) {
  return (
    <button
      onClick={onClick}
      className={
        'text-[12px] font-medium text-faint transition-colors ' +
        (danger ? 'hover:text-err' : 'hover:text-ink')
      }
    >
      {children}
    </button>
  )
}

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-card border border-dashed border-line-strong px-6 py-8 text-center text-[12.5px] text-faint">
      {children}
    </div>
  )
}

/** The larger, illustrated empty state a whole view falls back to. */
export function EmptyState({
  icon,
  title,
  children
}: {
  icon: React.ReactNode
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="pt-14 pb-10 flex flex-col items-center text-center">
      <div
        className="w-14 h-14 rounded-2xl grid place-items-center mb-5 border border-line"
        style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
      >
        {icon}
      </div>
      <h2 className="text-[15px] font-semibold text-ink/90">{title}</h2>
      <p className="mt-2 text-[13px] text-faint max-w-[400px] leading-relaxed">{children}</p>
    </div>
  )
}
