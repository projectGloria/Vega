import { useEffect, useState } from 'react'
import type { AudioCodec } from '@shared/types'
import { ACCENT_THEMES, useApp } from '../store/app'
import { toast } from '../store/toasts'
import { ToggleRow } from './Toggle'
import { confirmAction } from './ConfirmDialog'
import { PageHead } from './Layout'
import CookieSection from './CookieSection'
import { FolderIcon, TrashIcon } from './Icons'

export default function SettingsView() {
  const settings = useApp((s) => s.settings)
  const save = useApp((s) => s.saveSettings)
  const versions = useApp((s) => s.versions)

  const [updating, setUpdating] = useState(false)
  const [updateMessage, setUpdateMessage] = useState<string | null>(null)

  if (!settings) return null

  const pickFolder = async () => {
    const dir = await window.api.settings.pickDownloadDir()
    if (dir) await save({ downloadDir: dir })
  }

  const runUpdate = async () => {
    setUpdating(true)
    setUpdateMessage(null)
    try {
      const result = await window.api.settings.updateYtdlp()
      setUpdateMessage(result.message)
      toast(result.ok ? 'success' : 'danger', 'yt-dlp update', result.message)
      await useApp.getState().loadSettings()
    } finally {
      setUpdating(false)
    }
  }

  return (
    <>
      <PageHead title="Settings" subtitle="Tune Vega to your workflow." />

      <Group title="Downloads">
        <Row label="Save files to" hint="Where finished downloads land">
          <div className="flex items-center gap-2.5 min-w-0">
            <span
              className="text-[12px] text-muted bg-white/5 border border-line px-3 py-2 rounded-[9px] font-mono truncate max-w-[280px]"
              title={settings.downloadDir}
            >
              {settings.downloadDir}
            </span>
            <GhostButton onClick={pickFolder}>
              <FolderIcon className="w-3.5 h-3.5" />
              Browse
            </GhostButton>
          </div>
        </Row>

        <Row label="File name" hint="yt-dlp output template — %(title)s, %(id)s, %(ext)s">
          <CommittedInput
            value={settings.outputTemplate}
            onCommit={(value) => save({ outputTemplate: value })}
            mono
            className="w-[300px]"
          />
        </Row>

        <Row
          label="Simultaneous downloads"
          hint="How many run at once; the rest wait in the queue"
        >
          <ConcurrencySlider
            value={settings.concurrency}
            onCommit={(value) => save({ concurrency: value })}
          />
        </Row>
      </Group>

      <Group title="Defaults">
        <Row label="Preferred quality" hint="What the download sheet opens on">
          <Select
            value={String(settings.defaultQuality)}
            onChange={(value) =>
              save({ defaultQuality: value === 'best' ? 'best' : Number(value) })
            }
          >
            <option value="best">Best available</option>
            {[2160, 1440, 1080, 720, 480, 360].map((h) => (
              <option key={h} value={h}>
                Up to {h}p
              </option>
            ))}
          </Select>
        </Row>

        <Row label="Audio format" hint="Used when a download is stripped to audio">
          <Select
            value={settings.audioCodec}
            onChange={(value) => save({ audioCodec: value as AudioCodec })}
          >
            {['mp3', 'm4a', 'opus', 'flac', 'wav'].map((c) => (
              <option key={c} value={c}>
                {c.toUpperCase()}
              </option>
            ))}
          </Select>
        </Row>

        <Row label="Subtitle languages" hint="Comma separated, e.g. en,tr">
          <CommittedInput
            value={settings.subtitleLangs.join(',')}
            onCommit={(value) =>
              save({
                subtitleLangs: value
                  .split(',')
                  .map((l) => l.trim())
                  .filter(Boolean)
              })
            }
            className="w-[200px]"
          />
        </Row>
      </Group>

      <Group title="After download">
        <ToggleRow
          label="Embed subtitles"
          hint="On by default in the download sheet, where it can still be turned off per video"
          checked={settings.embedSubs}
          onChange={(v) => save({ embedSubs: v })}
        />
        <ToggleRow
          label="Embed thumbnail as cover art"
          checked={settings.embedThumbnail}
          onChange={(v) => save({ embedThumbnail: v })}
        />
        <ToggleRow
          label="Embed title and metadata"
          checked={settings.embedMetadata}
          onChange={(v) => save({ embedMetadata: v })}
        />
        <ToggleRow
          label="Remove sponsor segments"
          hint="Uses the SponsorBlock database"
          checked={settings.sponsorblock}
          onChange={(v) => save({ sponsorblock: v })}
        />
      </Group>

      <Group title="Behaviour">
        <ToggleRow
          label="Keep running in the tray when closed"
          hint="Lets Vega keep collecting copied links after you close the window"
          checked={settings.closeToTray}
          onChange={(v) => save({ closeToTray: v })}
        />
        <ToggleRow
          label="Read links automatically on paste"
          hint="Fetches the formats in the background so the download sheet opens ready"
          checked={settings.autoProbeOnPaste}
          onChange={(v) => save({ autoProbeOnPaste: v })}
        />
        <ToggleRow
          label="Offer links you copy"
          hint="Watches the clipboard and collects copied links — nothing is ever filled in for you"
          checked={settings.watchClipboard}
          onChange={(v) => save({ watchClipboard: v })}
        />
        <ToggleRow
          label="Keep yt-dlp up to date"
          hint="Sites change often; stale versions are the usual cause of failures"
          checked={settings.autoUpdateYtdlp}
          onChange={(v) => save({ autoUpdateYtdlp: v })}
        />
      </Group>

      <Group title="Appearance">
        <Row label="Accent colour" hint="Used for progress, buttons and highlights">
          <div className="flex gap-2.5">
            {ACCENT_THEMES.slice(0, 5).map((theme) => (
              <button
                key={theme.from}
                onClick={() => save({ accent: theme.from })}
                title={theme.name}
                aria-label={'Accent ' + theme.name}
                className={
                  'w-[26px] h-[26px] rounded-full border-2 transition-transform duration-150 hover:scale-110 ' +
                  (settings.accent.toLowerCase() === theme.from.toLowerCase()
                    ? 'border-white'
                    : 'border-transparent')
                }
                style={{
                  background: 'linear-gradient(135deg, ' + theme.from + ', ' + theme.to + ')'
                }}
              />
            ))}
          </div>
        </Row>
      </Group>

      <Group title="Sign-in cookies">
        <div className="py-4">
          <CookieSection />
        </div>
      </Group>

      <Group title="Categories">
        <div className="py-4">
          <p className="text-[12px] text-faint leading-relaxed mb-3">
            Categories are subfolders inside your download folder. Removing one here leaves its
            folder and files untouched.
          </p>
          <CategoryManager />
        </div>
      </Group>

      <Group title="Components">
        <Row label="yt-dlp" hint="Does the extracting and downloading">
          <span className="text-[12px] text-muted font-mono tabular-nums">
            {versions.ytdlp ?? 'not detected'}
          </span>
        </Row>
        <Row label="ffmpeg" hint="Merges the video and audio streams">
          <span className="text-[12px] text-muted font-mono tabular-nums">
            {versions.ffmpeg ?? 'not detected'}
          </span>
        </Row>
        <Row label="Update yt-dlp" hint={updateMessage ?? 'Check for a newer build right now'}>
          <GhostButton onClick={runUpdate} disabled={updating}>
            {updating ? 'Checking…' : 'Check now'}
          </GhostButton>
        </Row>
      </Group>
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Controls                                                            */
/* ------------------------------------------------------------------ */

/**
 * A text field that saves when you are done, not while you type.
 *
 * Writing on every keystroke meant a settings.json write and a round trip per
 * character, and because the value came back asynchronously from the main
 * process it could overwrite what had been typed in the meantime — characters
 * visibly reverted mid-word.
 */
function CommittedInput({
  value,
  onCommit,
  className,
  mono
}: {
  value: string
  onCommit(value: string): void
  className?: string
  mono?: boolean
}) {
  const [draft, setDraft] = useState(value)

  // Follow the stored value while the field is idle, so a change made elsewhere
  // is reflected here.
  useEffect(() => setDraft(value), [value])

  const commit = () => {
    if (draft !== value) onCommit(draft)
  }

  return (
    <input
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          commit()
          e.currentTarget.blur()
        }
        if (e.key === 'Escape') {
          setDraft(value)
          e.currentTarget.blur()
        }
      }}
      spellCheck={false}
      className={
        'px-3 py-2 rounded-[9px] bg-white/5 border border-line text-[12.5px] text-ink outline-none ' +
        'focus:border-[var(--accent-line)] transition-colors ' +
        (mono ? 'font-mono ' : '') +
        (className ?? '')
      }
    />
  )
}

/** Same idea as CommittedInput: track the drag locally, write once on release. */
function ConcurrencySlider({
  value,
  onCommit
}: {
  value: number
  onCommit(value: number): void
}) {
  const [draft, setDraft] = useState(value)

  useEffect(() => setDraft(value), [value])

  const commit = () => {
    if (draft !== value) onCommit(draft)
  }

  return (
    <div className="flex items-center gap-3">
      <input
        type="range"
        min={1}
        max={8}
        value={draft}
        onChange={(e) => setDraft(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        aria-label="Simultaneous downloads"
        className="w-[150px] accent-[var(--accent)]"
      />
      <span
        className="text-[13px] font-bold w-4 text-center tabular-nums"
        style={{ color: 'var(--accent)' }}
      >
        {draft}
      </span>
    </div>
  )
}

function CategoryManager() {
  const settings = useApp((s) => s.settings)
  const create = useApp((s) => s.createCategory)
  const remove = useApp((s) => s.removeCategory)
  const save = useApp((s) => s.saveSettings)

  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)

  const categories = settings?.categories ?? []

  const add = async () => {
    const trimmed = name.trim()
    if (!trimmed) return
    try {
      await create(trimmed)
      setName('')
      setError(null)
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')
          : 'Could not create that category.'
      )
    }
  }

  return (
    <div className="space-y-2.5">
      <div className="flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void add()
          }}
          placeholder="New category, e.g. Gaming"
          maxLength={60}
          className="flex-1 px-3 py-2 rounded-[9px] bg-white/5 border border-line text-[12.5px]
                     text-ink placeholder:text-faint outline-none focus:border-[var(--accent-line)] transition-colors"
        />
        <button
          onClick={add}
          disabled={!name.trim()}
          className="px-4 py-2 rounded-[9px] text-[12.5px] font-semibold text-white
                     transition-all hover:brightness-110 disabled:opacity-40"
          style={{ background: 'var(--grad)' }}
        >
          Add
        </button>
      </div>

      {error && <p className="text-[11.5px] text-err/80">{error}</p>}

      {categories.length > 0 && (
        <div className="rounded-[9px] border border-line overflow-hidden">
          {categories.map((category, index) => (
            <div
              key={category.id}
              className={
                'flex items-center gap-2 px-3 py-2 bg-white/[0.02] ' +
                (index > 0 ? 'border-t border-line' : '')
              }
            >
              <span className="flex-1 min-w-0 truncate text-[12.5px] text-ink">
                {category.name}
              </span>
              <span className="text-[11px] text-faint font-mono truncate max-w-[140px]">
                /{category.folder}
              </span>
              <button
                onClick={() =>
                  confirmAction({
                    title: 'Remove the "' + category.name + '" category?',
                    message:
                      'The category is removed from Vega. Its folder and every file inside it are left exactly where they are.',
                    onConfirm: () => remove(category.id)
                  })
                }
                className="p-1 rounded-md text-faint hover:text-err hover:bg-err/10 transition-colors"
                title={'Remove ' + category.name}
              >
                <TrashIcon className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {categories.length > 0 && (
        <div className="flex items-center gap-3 pt-1">
          <span className="text-[12px] text-muted">Preselected category</span>
          <Select
            value={settings?.defaultCategoryId ?? ''}
            onChange={(value) => save({ defaultCategoryId: value || null })}
          >
            <option value="">No category</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Layout primitives                                                   */
/* ------------------------------------------------------------------ */

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="surface-card rounded-[14px] px-5 pb-1.5 mb-4">
      <h3 className="font-display text-[13px] font-bold pt-3.5 pb-1">{title}</h3>
      {children}
    </section>
  )
}

function Row({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-5 py-4 border-t border-line first:border-t-0 flex-wrap">
      <div className="min-w-0">
        <b className="block text-[13px] font-semibold mb-0.5">{label}</b>
        {hint && <span className="block text-[12px] text-faint leading-relaxed">{hint}</span>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

function Select({
  value,
  onChange,
  children
}: {
  value: string
  onChange(value: string): void
  children: React.ReactNode
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="bg-raised border border-line rounded-[9px] px-3 py-2 text-[12.5px] text-ink
                 outline-none hover:border-line-strong transition-colors"
    >
      {children}
    </select>
  )
}

function GhostButton({
  children,
  onClick,
  disabled
}: {
  children: React.ReactNode
  onClick(): void
  disabled?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-2 px-3.5 py-2 rounded-[9px] text-[12.5px] font-semibold
                 border border-line bg-white/5 text-muted hover:bg-white/[0.09] hover:text-ink
                 transition-all disabled:opacity-40"
    >
      {children}
    </button>
  )
}
