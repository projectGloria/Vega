import { useState } from 'react'
import { useApp } from '../store/app'
import { CloseIcon, FolderIcon } from './Icons'

/**
 * Categories are subfolders. Picking one here means the download lands in
 * <downloads>/<category>/ instead of the root.
 */
export default function CategoryPicker() {
  const settings = useApp((s) => s.settings)
  const activeCategoryId = useApp((s) => s.activeCategoryId)
  const setActiveCategory = useApp((s) => s.setActiveCategory)
  const createCategory = useApp((s) => s.createCategory)

  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)

  const categories = settings?.categories ?? []

  const submit = async () => {
    const trimmed = name.trim()
    if (!trimmed) {
      setAdding(false)
      return
    }
    try {
      await createCategory(trimmed)
      setName('')
      setAdding(false)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? cleanError(err.message) : 'Could not create that category.')
    }
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-[12px] text-faint flex items-center gap-1.5">
        <FolderIcon className="w-3.5 h-3.5" />
        Save to
      </span>

      <Chip
        active={activeCategoryId === null}
        onClick={() => setActiveCategory(null)}
        label="No category"
      />

      {categories.map((category) => (
        <Chip
          key={category.id}
          active={activeCategoryId === category.id}
          onClick={() => setActiveCategory(category.id)}
          label={category.name}
        />
      ))}

      {adding ? (
        <span className="inline-flex items-center gap-1">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit()
              if (e.key === 'Escape') {
                setAdding(false)
                setName('')
                setError(null)
              }
            }}
            onBlur={() => void submit()}
            placeholder="Category name"
            maxLength={60}
            className="w-32 px-2.5 py-1 rounded-lg bg-raised border border-line text-[12px]
                       text-ink outline-none focus:border-[var(--accent-line)]"
          />
          <button
            onClick={() => {
              setAdding(false)
              setName('')
              setError(null)
            }}
            className="p-1 rounded-md text-faint hover:text-ink"
            aria-label="Cancel"
          >
            <CloseIcon className="w-3 h-3" />
          </button>
        </span>
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="px-2.5 py-1 rounded-lg border border-dashed border-line text-[12px]
                     text-faint hover:text-ink hover:border-line-strong transition-colors"
        >
          + New
        </button>
      )}

      {error && <span className="text-[11.5px] text-err/80 w-full">{error}</span>}
    </div>
  )
}

function Chip({ active, onClick, label }: { active: boolean; onClick(): void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={
        'px-2.5 py-1 rounded-lg text-[12px] border transition-all duration-150 max-w-[160px] truncate ' +
        (active ? 'text-ink' : 'border-line text-muted hover:text-ink hover:border-line-strong')
      }
      style={active ? { borderColor: 'var(--accent-line)', background: 'var(--accent-soft)' } : undefined}
      title={label}
    >
      {label}
    </button>
  )
}

function cleanError(message: string): string {
  return message.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')
}
