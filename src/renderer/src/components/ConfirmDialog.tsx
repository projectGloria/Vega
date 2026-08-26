import { useEffect } from 'react'
import { create } from 'zustand'
import { AlertIcon } from './Icons'

interface ConfirmRequest {
  title: string
  message: string
  /** Label for the destructive action, e.g. "Remove". */
  confirmLabel?: string
  /** Styles the confirm button as destructive. Defaults to true. */
  destructive?: boolean
  onConfirm(): void
}

interface ConfirmState {
  request: ConfirmRequest | null
  ask(request: ConfirmRequest): void
  dismiss(): void
}

const useConfirmStore = create<ConfirmState>((set) => ({
  request: null,
  ask: (request) => set({ request }),
  dismiss: () => set({ request: null })
}))

/**
 * Every destructive action goes through here. Removing a download, a captured
 * link, a history entry or a category is easy to hit by accident and, for
 * history especially, impossible to undo — so each one asks first.
 */
export function confirmAction(request: ConfirmRequest): void {
  useConfirmStore.getState().ask(request)
}

export default function ConfirmDialog() {
  const request = useConfirmStore((s) => s.request)
  const dismiss = useConfirmStore((s) => s.dismiss)

  useEffect(() => {
    if (!request) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [request, dismiss])

  if (!request) return null

  const destructive = request.destructive ?? true

  const confirm = () => {
    request.onConfirm()
    dismiss()
  }

  return (
    <div
      className="fixed inset-0 z-[80] grid place-items-center p-6"
      style={{ background: 'rgba(0,0,0,0.55)' }}
      onClick={dismiss}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className="pop-in w-full max-w-[400px] rounded-2xl bg-surface border border-line shadow-2xl overflow-hidden"
      >
        <div className="p-5 flex gap-3.5">
          <span
            className="w-9 h-9 rounded-xl grid place-items-center shrink-0"
            style={{
              background: destructive ? 'rgba(255,107,107,0.12)' : 'var(--accent-soft)',
              color: destructive ? 'var(--color-err)' : 'var(--accent)'
            }}
          >
            <AlertIcon className="w-[18px] h-[18px]" />
          </span>

          <div className="min-w-0 flex-1">
            <h2 className="text-[14px] font-semibold text-ink">{request.title}</h2>
            <p className="mt-1.5 text-[12.5px] text-muted leading-relaxed">{request.message}</p>
          </div>
        </div>

        <div className="flex justify-end gap-2 px-5 py-3.5 border-t border-line/60 bg-black/20">
          <button
            onClick={dismiss}
            className="px-3.5 py-2 rounded-lg text-[12.5px] text-muted border border-line
                       hover:text-ink hover:bg-white/6 transition-colors"
          >
            Cancel
          </button>
          <button
            autoFocus
            onClick={confirm}
            className="px-3.5 py-2 rounded-lg text-[12.5px] font-semibold transition-all hover:brightness-110"
            style={
              destructive
                ? { background: 'var(--color-err)', color: '#fff' }
                : { background: 'var(--accent)', color: 'var(--color-ground)' }
            }
          >
            {request.confirmLabel ?? 'Remove'}
          </button>
        </div>
      </div>
    </div>
  )
}
