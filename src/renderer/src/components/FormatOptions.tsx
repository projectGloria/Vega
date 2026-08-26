import { useMemo, useState } from 'react'
import type { AudioCodec, DownloadSelection, MediaFormat, VideoInfo } from '@shared/types'
import { formatBytes } from '../lib/format'
import { ChevronIcon } from './Icons'

const AUDIO_CODECS: { value: AudioCodec; label: string }[] = [
  { value: 'mp3', label: 'MP3' },
  { value: 'm4a', label: 'M4A' },
  { value: 'opus', label: 'Opus' },
  { value: 'flac', label: 'FLAC' },
  { value: 'wav', label: 'WAV' }
]

const AUDIO_QUALITIES = ['best', '320', '192', '128'] as const

/* ------------------------------------------------------------------ */
/* Size estimates                                                      */
/* ------------------------------------------------------------------ */

/** Best audio stream, which every merged download pairs with the video. */
function bestAudio(info: VideoInfo) {
  return info.formats
    .filter((f) => f.kind === 'audio' && f.filesize)
    .sort((a, b) => (b.tbr ?? 0) - (a.tbr ?? 0))[0]
}

/**
 * A quality row downloads the best video at or below that height merged with
 * the best audio, so the estimate has to add both streams together.
 */
function estimateForHeight(info: VideoInfo, height: number): number | null {
  const video = bestVideoUpTo(info, height)
  if (!video?.filesize) return null
  if (video.kind === 'combined') return video.filesize
  return video.filesize + (bestAudio(info)?.filesize ?? 0)
}

function bestVideoUpTo(info: VideoInfo, height: number): MediaFormat | undefined {
  return info.formats
    .filter((f) => f.kind !== 'audio' && f.height !== null && f.height <= height)
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.tbr ?? 0) - (a.tbr ?? 0))[0]
}

function topVideo(info: VideoInfo): MediaFormat | undefined {
  return info.formats
    .filter((f) => f.kind !== 'audio')
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.tbr ?? 0) - (a.tbr ?? 0))[0]
}

/** Matches what `mode: 'best'` actually downloads: top video + top audio. */
function estimateBest(info: VideoInfo): number | null {
  const video = topVideo(info)
  if (!video?.filesize) return null
  if (video.kind === 'combined') return video.filesize
  return video.filesize + (bestAudio(info)?.filesize ?? 0)
}

function estimateForFormat(info: VideoInfo, formatId: string): number | null {
  const format = info.formats.find((f) => f.formatId === formatId)
  if (!format?.filesize) return null
  if (format.kind === 'video') return format.filesize + (bestAudio(info)?.filesize ?? 0)
  return format.filesize
}

/** Rough audio-only size from the bitrate the user picked. */
function estimateAudio(info: VideoInfo, quality: string): number | null {
  if (quality === 'best' || info.duration === null) return bestAudio(info)?.filesize ?? null

  const kbps = Number(quality)
  if (!Number.isFinite(kbps)) return null
  return Math.round((kbps * 1000 * info.duration) / 8)
}

/** The estimate for whatever is currently selected, shown next to Start. */
export function estimateForSelection(
  info: VideoInfo,
  selection: DownloadSelection
): number | null {
  switch (selection.mode) {
    case 'best':
      return estimateBest(info)
    case 'quality':
      return estimateForHeight(info, selection.height)
    case 'format':
      return estimateForFormat(info, selection.formatId)
    case 'audio':
      return estimateAudio(info, selection.quality)
  }
}

/** The tallest stream on offer, so the Best row can say what it will fetch. */
function bestHeight(info: VideoInfo): number | null {
  return topVideo(info)?.height ?? null
}

/** Marketing-ish name for a height, matching how sites label them. */
function heightName(height: number): string {
  if (height >= 4320) return '8K UHD'
  if (height >= 2160) return '4K UHD'
  if (height >= 1440) return 'QHD'
  if (height >= 1080) return 'Full HD'
  if (height >= 720) return 'HD'
  return 'SD'
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

interface Props {
  info: VideoInfo
  selection: DownloadSelection
  onChange(selection: DownloadSelection): void
  embedSubs: boolean
  onEmbedSubsChange(value: boolean): void
}

export default function FormatOptions({
  info,
  selection,
  onChange,
  embedSubs,
  onEmbedSubsChange
}: Props) {
  const [showAll, setShowAll] = useState(false)

  const audioCodec = selection.mode === 'audio' ? selection.codec : 'mp3'
  const audioQuality = selection.mode === 'audio' ? selection.quality : 'best'
  const isAudio = selection.mode === 'audio'

  const tableFormats = useMemo(
    () => info.formats.filter((f) => (isAudio ? f.kind === 'audio' : f.kind !== 'audio')),
    [info.formats, isAudio]
  )

  const hasSubtitles = info.subtitles.length > 0
  const top = bestHeight(info)

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2">
        {/* "Best" means no height cap and no forced container — genuinely the
            highest streams the site offers, not the best that fits in an mp4. */}
        <Option
          selected={selection.mode === 'best'}
          onClick={() => onChange({ mode: 'best' })}
          name="Best available"
          recommended
          sub={
            (top ? top + 'p' : 'Highest streams') + ' · original container, no re-encode'
          }
          size={estimateBest(info)}
        />

        {info.qualities.map((height) => {
          const format = bestVideoUpTo(info, height)
          const codec = format?.label.split(' · ')[1]
          return (
            <Option
              key={height}
              selected={selection.mode === 'quality' && selection.height === height}
              onClick={() => onChange({ mode: 'quality', height })}
              name={height + 'p · ' + heightName(height)}
              sub={'MP4' + (codec ? ' · ' + codec : '') + ' · merged video and audio'}
              size={estimateForHeight(info, height)}
            />
          )
        })}

        <Option
          selected={isAudio}
          onClick={() => onChange({ mode: 'audio', codec: audioCodec, quality: audioQuality })}
          name="Audio only"
          sub={
            audioCodec.toUpperCase() +
            (audioQuality === 'best' ? ' · best available' : ' · ' + audioQuality + ' kbps')
          }
          size={estimateAudio(info, audioQuality)}
        />
      </div>

      {isAudio && (
        <div className="fade-up rounded-[11px] border border-line bg-black/20 p-3 space-y-2.5">
          <Row label="Format">
            {AUDIO_CODECS.map((codec) => (
              <Pill
                key={codec.value}
                active={audioCodec === codec.value}
                onClick={() =>
                  onChange({ mode: 'audio', codec: codec.value, quality: audioQuality })
                }
                label={codec.label}
              />
            ))}
          </Row>

          {/* Lossless formats ignore a bitrate target, so hide the choice there. */}
          {audioCodec !== 'flac' && audioCodec !== 'wav' && (
            <Row label="Bitrate">
              {AUDIO_QUALITIES.map((quality) => (
                <Pill
                  key={quality}
                  active={audioQuality === quality}
                  onClick={() => onChange({ mode: 'audio', codec: audioCodec, quality })}
                  label={quality === 'best' ? 'Best' : quality + 'k'}
                />
              ))}
            </Row>
          )}
        </div>
      )}

      {hasSubtitles && !isAudio && (
        <button
          onClick={() => onEmbedSubsChange(!embedSubs)}
          className="flex items-center gap-2.5 text-left w-full rounded-lg px-1 py-1 hover:bg-white/[0.03] transition-colors"
        >
          <span
            className={
              'w-[18px] h-[18px] rounded-[6px] border grid place-items-center shrink-0 transition-all duration-150 ' +
              (embedSubs ? 'border-transparent' : 'border-line-strong')
            }
            style={embedSubs ? { background: 'var(--accent)' } : undefined}
          >
            {embedSubs && (
              <svg viewBox="0 0 24 24" className="w-3 h-3" fill="none" stroke="#0b0e15" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <path d="m5 12.5 4.5 4.5L19 7.5" />
              </svg>
            )}
          </span>
          <span className="text-[12.5px] text-muted">
            Embed subtitles
            <span className="text-faint"> · {info.subtitles.length} available</span>
          </span>
        </button>
      )}

      {tableFormats.length > 0 && (
        <div>
          <button
            onClick={() => setShowAll(!showAll)}
            className="flex items-center gap-1.5 text-[12px] text-faint hover:text-muted transition-colors"
          >
            <ChevronIcon
              className={
                'w-3.5 h-3.5 transition-transform duration-150 ' + (showAll ? 'rotate-180' : '')
              }
            />
            {showAll ? 'Hide' : 'Show'} all {tableFormats.length} formats
          </button>

          {showAll && (
            <FormatTable
              formats={tableFormats}
              selectedId={selection.mode === 'format' ? selection.formatId : null}
              onSelect={(format) =>
                onChange({
                  mode: 'format',
                  formatId: format.formatId,
                  // A video-only stream has to be merged with audio to be watchable.
                  needsAudio: format.kind === 'video'
                })
              }
            />
          )}
        </div>
      )}
    </div>
  )
}

function Option({
  selected,
  onClick,
  name,
  sub,
  size,
  recommended
}: {
  selected: boolean
  onClick(): void
  name: string
  sub: string
  size: number | null
  recommended?: boolean
}) {
  return (
    <button
      onClick={onClick}
      className={
        'flex items-center gap-3 px-3.5 py-2.5 rounded-[11px] border text-left transition-all duration-150 ' +
        (selected ? '' : 'border-line bg-white/[0.02] hover:border-line-strong')
      }
      style={
        selected
          ? { borderColor: 'var(--accent-line)', background: 'var(--accent-soft)' }
          : undefined
      }
    >
      <span
        className={
          'relative w-4 h-4 rounded-full border-2 shrink-0 transition-all duration-150 ' +
          (selected ? '' : 'border-faint')
        }
        style={selected ? { borderColor: 'var(--accent)' } : undefined}
      >
        {selected && (
          <span
            className="absolute inset-[3px] rounded-full"
            style={{ background: 'var(--accent)' }}
          />
        )}
      </span>

      <span className="flex-1 min-w-0">
        <span className="flex items-center gap-2 text-[13px] font-semibold text-ink">
          <span className="truncate">{name}</span>
          {recommended && (
            <span
              className="shrink-0 text-[9.5px] font-bold tracking-[0.6px] px-[7px] py-0.5 rounded-full"
              style={{ color: 'var(--color-ok)', background: 'rgba(52,211,153,0.1)' }}
            >
              BEST
            </span>
          )}
        </span>
        <span className="block text-[11px] text-faint font-normal mt-0.5 truncate">{sub}</span>
      </span>

      {/* Always render the figure: a blank cell reads as "no size", which is a
          different claim from "the site did not report one". */}
      <span className="text-[12px] text-muted tabular-nums shrink-0">
        {size !== null ? '≈ ' + formatBytes(size) : '—'}
      </span>
    </button>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-[11.5px] text-faint w-14 shrink-0">{label}</span>
      {children}
    </div>
  )
}

function Pill({
  active,
  onClick,
  label
}: {
  active: boolean
  onClick(): void
  label: string
}) {
  return (
    <button
      onClick={onClick}
      className={
        'px-2.5 py-1 rounded-lg text-[12px] border transition-all duration-150 ' +
        (active ? 'text-ink' : 'border-line text-muted hover:text-ink hover:border-line-strong')
      }
      style={
        active
          ? { borderColor: 'var(--accent-line)', background: 'var(--accent-soft)' }
          : undefined
      }
    >
      {label}
    </button>
  )
}

function FormatTable({
  formats,
  selectedId,
  onSelect
}: {
  formats: MediaFormat[]
  selectedId: string | null
  onSelect(format: MediaFormat): void
}) {
  return (
    <div className="fade-up mt-2.5 rounded-[11px] border border-line overflow-hidden">
      <div className="max-h-52 overflow-y-auto overflow-x-auto">
        <table className="w-full text-[12px] border-collapse">
          <thead className="sticky top-0 bg-raised/95 backdrop-blur">
            <tr className="text-faint text-left">
              <th className="font-medium px-3 py-2">Format</th>
              <th className="font-medium px-3 py-2">Ext</th>
              <th className="font-medium px-3 py-2">Codec</th>
              <th className="font-medium px-3 py-2 text-right whitespace-nowrap">Size</th>
            </tr>
          </thead>
          <tbody>
            {formats.map((format) => {
              const active = selectedId === format.formatId
              return (
                <tr
                  key={format.formatId}
                  onClick={() => onSelect(format)}
                  className={
                    'cursor-pointer border-t border-line transition-colors ' +
                    (active ? 'text-ink' : 'text-muted hover:bg-white/[0.04] hover:text-ink')
                  }
                  style={active ? { background: 'var(--accent-soft)' } : undefined}
                >
                  <td className="px-3 py-1.5 whitespace-nowrap">
                    {format.label}
                    {format.kind === 'video' && (
                      <span className="ml-1.5 text-faint text-[11px]">video only</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-faint">{format.ext}</td>
                  <td className="px-3 py-1.5 text-faint whitespace-nowrap">
                    {format.vcodec?.split('.')[0] ?? format.acodec?.split('.')[0] ?? '—'}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums whitespace-nowrap">
                    {format.filesize ? (
                      <>
                        {format.filesizeIsEstimate && <span className="text-faint">~</span>}
                        {formatBytes(format.filesize)}
                      </>
                    ) : (
                      <span className="text-faint">—</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
