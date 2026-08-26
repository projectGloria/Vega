import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import type { RendererApi } from '@shared/types'
import App from './App'

/*
 * Fonts are bundled rather than pulled from a CDN: the renderer runs under a
 * `default-src 'self'` CSP, so a remote stylesheet is simply blocked and every
 * heading silently falls back to a system face.
 *
 * They are imported here rather than with `@import` inside theme.css on
 * purpose. Tailwind's PostCSS plugin inlines a CSS-level @import itself, and
 * the `url(./files/...)` references inside then get resolved relative to
 * theme.css instead of the package — Vite emits no font files at all and the
 * built stylesheet points at paths that do not exist. Importing from here keeps
 * each stylesheet its own module, so the URLs resolve and the woff2 files are
 * emitted. The full-weight files carry unicode-range blocks, so only the
 * subsets a given title needs are actually fetched.
 */
import '@fontsource/space-grotesk/500.css'
import '@fontsource/space-grotesk/700.css'
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import './styles/theme.css'

declare global {
  interface Window {
    api: RendererApi
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
