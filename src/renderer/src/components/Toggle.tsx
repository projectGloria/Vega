/**
 * Switch control.
 *
 * Two things were wrong with an earlier version and both are still guarded
 * against here:
 *
 *  - It was a <button> inside a <label>. A button is a labelable element, so
 *    the label forwarded the click to it *as well as* the button's own handler
 *    firing — every click toggled twice and appeared to do nothing. Nothing in
 *    this file is wrapped in a label, and callers should not add one.
 *  - The knob was positioned with translate-x on an element that had no `left`,
 *    so its start position depended on the button's content box and it could
 *    slide outside the track. It uses explicit left offsets instead.
 */

const TRACK_W = 40
const TRACK_H = 22
const KNOB = 16
const INSET = 3

export function Toggle({
  checked,
  onChange,
  label
}: {
  checked: boolean
  onChange(value: boolean): void
  label?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation()
        onChange(!checked)
      }}
      className="relative shrink-0 rounded-full transition-colors duration-200 cursor-pointer"
      style={{
        width: TRACK_W,
        height: TRACK_H,
        background: checked ? 'var(--grad)' : 'rgba(255,255,255,0.12)'
      }}
    >
      <span
        className="absolute rounded-full bg-white transition-[left] duration-200 ease-[cubic-bezier(0.4,0,0.2,1)]"
        style={{
          width: KNOB,
          height: KNOB,
          top: (TRACK_H - KNOB) / 2,
          left: checked ? TRACK_W - KNOB - INSET : INSET
        }}
      />
    </button>
  )
}

/**
 * A settings row: description on the left, switch on the right, the whole row
 * clickable. Deliberately a div, not a label — one handler, so there is no
 * second activation path to double-fire.
 */
export function ToggleRow({
  label,
  hint,
  checked,
  onChange
}: {
  label: string
  hint?: string
  checked: boolean
  onChange(value: boolean): void
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onChange(!checked)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onChange(!checked)
        }
      }}
      className="flex items-center justify-between gap-5 py-4 border-t border-line first:border-t-0 cursor-pointer group select-none"
    >
      <div className="min-w-0">
        <b className="block text-[13px] font-semibold mb-0.5">{label}</b>
        {hint && <span className="block text-[12px] text-faint leading-relaxed">{hint}</span>}
      </div>
      <div className="pointer-events-none shrink-0">
        <Toggle checked={checked} onChange={onChange} label={label} />
      </div>
    </div>
  )
}
