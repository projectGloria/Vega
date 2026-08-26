import type { CookieBrowser } from '@shared/types'

/**
 * Browser marks, drawn inline rather than loaded as files.
 *
 * The renderer has no filesystem and the app ships no remote assets, so these
 * are paths in their brand colours — recognisable at 22px, which is the only
 * size they are used at. Each keeps its own colours in both themes: a browser
 * logo tinted to the accent stops reading as that browser.
 */

interface Props {
  className?: string
}

function Brave({ className }: Props) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <path
        d="M16 3.2 22.6 5l1.9-2 3.6 3.7-.9 2.4 1.2 3.3-2.4 9.2c-.6 2.3-1.7 3.6-3.4 4.7L16 29.4l-6.6-3.1c-1.7-1.1-2.8-2.4-3.4-4.7L3.6 12.4l1.2-3.3-.9-2.4L7.5 3l1.9 2Z"
        fill="#F1521F"
      />
      <path
        d="m16 7.4 4.9 1.3 1.1-1.2 2.2 2.2-.6 1.5.8 2.1-1.6 6c-.4 1.5-1.1 2.4-2.2 3.1L16 24.6l-4.6-2.2c-1.1-.7-1.8-1.6-2.2-3.1l-1.6-6 .8-2.1-.6-1.5 2.2-2.2 1.1 1.2Z"
        fill="#fff"
        opacity=".22"
      />
      <path
        d="M16 10.6c.3 0 2.6 3 2.9 3.4.3.4.1.7-.2.9l-2.2 1.3c-.3.2-.7.2-1 0l-2.2-1.3c-.3-.2-.5-.5-.2-.9.3-.4 2.6-3.4 2.9-3.4Zm0 7.3 2.3 1.3c.3.2.3.5 0 .7l-1.9 1.5c-.3.2-.5.2-.8 0l-1.9-1.5c-.3-.2-.3-.5 0-.7L16 17.9Z"
        fill="#fff"
      />
    </svg>
  )
}

function Chrome({ className }: Props) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <path d="M16 3a13 13 0 0 1 11.3 6.6H16a6.4 6.4 0 0 0-6.1 4.5L4.6 9A13 13 0 0 1 16 3Z" fill="#EA4335" />
      <path d="M27.3 9.6A13 13 0 0 1 16 29l5.6-9.7A6.4 6.4 0 0 0 22.4 16a6.4 6.4 0 0 0-1-3.4Z" fill="#FBBC05" />
      <path d="M16 29A13 13 0 0 1 4.6 9l5.3 5.1a6.4 6.4 0 0 0 5.5 8.3Z" fill="#34A853" />
      <circle cx="16" cy="16" r="5.6" fill="#fff" />
      <circle cx="16" cy="16" r="4.4" fill="#4285F4" />
    </svg>
  )
}

function Edge({ className }: Props) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <path
        d="M27.7 21.9c-1.3 2-3.6 3.4-6.2 3.4-4 0-7-2.7-7-6.2 0-1.9 1.1-3.3 2.6-4.2-3.6.2-6.6 1.9-8.6 4.6-.3-1.1-.4-2.2-.4-3.4C8.1 9.3 13.4 4 20 4c5.4 0 9.8 3.6 9.8 8.3 0 3.5-2.4 5.6-5.6 5.6-1.5 0-2.6-.5-2.6-1.4 0-.3.1-.6.2-.9-1.5 2.6.4 5.5 3.5 5.5.9 0 1.7-.2 2.4-.5Z"
        fill="#0F7EBC"
      />
      <path
        d="M8.1 16.1c0 1.2.1 2.3.4 3.4 1.3 4.9 5.3 8.5 10.3 8.5 2.6 0 5-.8 6.9-2.1-2.3 1.1-6.6 1.4-9.6-.9-2.4-1.8-3.3-4.3-3.3-6.2 0-2.5 1.3-4.6 3.3-5.9-3.4.4-6.2 1.7-8 3.2Z"
        fill="#2AC3E6"
      />
      <path
        d="M13.9 27.4C8.5 26.1 4.5 21.5 4.5 16 4.5 9.4 9.9 4 16.5 4c-6.1.5-10.9 5.4-10.9 11.4 0 5.5 3.5 10.2 8.3 12Z"
        fill="#37D39B"
      />
    </svg>
  )
}

function Opera({ className }: Props) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <ellipse cx="16" cy="16" rx="13" ry="13" fill="#FF1B2D" />
      <ellipse cx="16" cy="16" rx="5.4" ry="9.6" fill="#fff" />
    </svg>
  )
}

function Vivaldi({ className }: Props) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <circle cx="16" cy="16" r="13" fill="#EF3939" />
      <path
        d="M10 11.4h3.1l2.9 6.9 2.9-6.9H22l-4.6 10.2h-2.8Z"
        fill="#fff"
        stroke="#fff"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function Firefox({ className }: Props) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <circle cx="16" cy="16.6" r="12.4" fill="#FF7139" />
      <path
        d="M28.4 16.6a12.4 12.4 0 0 1-19.6 10c4.3 1.4 9-.1 11.2-3.5 2.4-3.7.7-7.8-1.4-9.4-1.6-1.2-1.4-3.3-.3-4.4-2.6.4-4.1 2.4-4.4 4.6-.3 2.4 1 3.9 1 5.6a2.9 2.9 0 0 1-5.5 1.3c-1-2-.5-4.9 1.3-7.1-2.6 1-4.6 3.6-4.9 6.7-.3 2.6.6 4.8 1.6 6.2A12.4 12.4 0 0 1 16 4.2c3.1 0 5.5 1.2 7.1 2.8-.6-.2-2.2-.5-3.4 0 2.5.8 5 2.7 6.4 5.4.9 1.6 1.4 2.9 1.4 4.2Z"
        fill="#FFBD4F"
      />
      <path
        d="M26.1 12.4c1.1 2.1 1.6 4.4 1.1 7-1.1 5.6-6.3 9.3-11.7 8.6-4.2-.5-7-3-8.2-5.5-1-1.4-1.9-3.6-1.6-6.2.3-3.1 2.3-5.7 4.9-6.7-1.8 2.2-2.3 5.1-1.3 7.1a2.9 2.9 0 0 0 5.5-1.3c0-1.7-1.3-3.2-1-5.6.3-2.2 1.8-4.2 4.4-4.6-1.1 1.1-1.3 3.2.3 4.4 2.1 1.6 3.8 5.7 1.4 9.4-2.2 3.4-6.9 4.9-11.2 3.5"
        fill="none"
      />
    </svg>
  )
}

const ICONS: Record<CookieBrowser, (props: Props) => React.ReactElement> = {
  brave: Brave,
  chrome: Chrome,
  edge: Edge,
  opera: Opera,
  vivaldi: Vivaldi,
  firefox: Firefox
}

export function BrowserIcon({
  browser,
  className = 'w-[22px] h-[22px]'
}: {
  browser: CookieBrowser
  className?: string
}) {
  const Icon = ICONS[browser]
  return <Icon className={className} />
}
