# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # electron-vite dev server with renderer HMR
npm run build      # typecheck both projects, then build main/preload/renderer into out/
npm run typecheck  # tsc on tsconfig.node.json (main+preload) and tsconfig.web.json (renderer)
npm run dist       # build + electron-builder --win → NSIS installer and portable exe in dist/
npm run pack       # build + unpacked app dir only (faster than dist for smoke tests)
npm start          # electron-vite preview against the built output
```

There is no test suite. Verification is done by running the app — see "Verifying changes" below.

To regenerate the app icon after changing the brand color, re-run the generator that produced
`resources/icon.ico` (a standalone Node script; it renders at 4x and packs a multi-size ICO).

## Architecture

Electron app wrapping `yt-dlp` and `ffmpeg`. Three processes with one direction of trust:

```
renderer (React)  ──contextBridge──▶  preload  ──typed IPC──▶  main (Node)
                                                                   │ spawn, shell:false
                                                          yt-dlp.exe → ffmpeg.exe
```

The renderer has no Node, no filesystem, and no child processes. Everything privileged lives in
`src/main/` and is reached only through the channels registered in `src/main/ipc.ts`.

`src/shared/types.ts` is the contract between the two sides — the `RendererApi` interface there
describes the entire `window.api` surface. Changing an IPC channel means touching three files in
lockstep: `shared/types.ts`, `main/ipc.ts`, `preload/index.ts`.

### Startup is a real sequence, not a delay

`main/index.ts` shows a splash window *before* any slow work, runs `main/bootstrap/`, and only
creates the main window once every step passes. The bootstrapper streams `{step, status, percent}`
to the splash, which renders it as a checklist with a progress bar.

Steps run in order: app data dirs → yt-dlp → ffmpeg → probe → cache → settings. yt-dlp and ffmpeg
are **downloaded on first launch** into `%APPDATA%/VideoDownloader/bin`, not bundled. A failed step
turns the splash into an error card with Retry / Continue anyway — it must never hang on a spinner.

### Non-obvious constraints

These are the things that break if you are not careful:

- **Kill process *trees*, not PIDs.** yt-dlp spawns ffmpeg as a child during merges. Killing only
  the yt-dlp PID orphans a 200MB ffmpeg that holds the output file open. `ytdlp/runner.ts` uses
  `taskkill /T /F` for this. After any change to cancel/pause, check Task Manager for stray
  `ffmpeg.exe`.
- **Never build a command string.** Titles and URLs come from the network and from user paste.
  Every spawn passes an argument array with `shell: false`, and the URL goes last after `--`.
  `validateUrl()` in `ytdlp/metadata.ts` is the real boundary — it runs in main, not just in the UI.
- **Do not scrape yt-dlp's progress bar.** It reflows, uses carriage returns, and changes between
  releases. `ytdlp/progress.ts` installs a `--progress-template` that emits a `DLPROG|…` line and
  parses that. Progress IPC is throttled to ~10/sec per item; yt-dlp emits far faster than the UI
  can paint.
- **`--no-quiet` is load-bearing, and must stay after `--print`.** `--print` implies `--quiet`, so
  the `after_move:` line that reports the final path also silences every other console message.
  Three things depend on those messages: the `merging` status comes from seeing `[Merger]` /
  `[ExtractAudio]`, the per-item details panel *is* that output, and `parseDestinationLine` is the
  fallback for when `after_move` never fires. Without the flag a 17-second mp3 transcode reads as
  "Downloading, 100%" and the log panel is permanently empty — with no error anywhere to say so.
- **`--ignore-config` is load-bearing.** Without it, a stray `yt-dlp.conf` on the user's machine
  silently changes output paths and formats.
- **A playlist row is read one process at a time.** `-J --flat-playlist` gives a title and nothing
  else per entry — a channel arrives as tabs with their videos already inlined, so flattening it
  costs no extra calls, but thumbnails, sizes and quality lists do: one `probeEntry` run per video.
  Rows are probed as they scroll into view, capped in `metadata.ts` and again in `store/app.ts`;
  probing a 658-video channel up front would be 658 yt-dlp runs. `--no-playlist` on that per-entry
  probe is what stops a `watch?v=…&list=…` row from resolving back to the playlist it came from.
- **Downloaded binaries are slow on their *first* run.** `yt-dlp.exe` is a PyInstaller bundle that
  unpacks itself, and a freshly downloaded exe also gets a full Defender scan. The version probe in
  `bootstrap/probe.ts` allows 90s for this; a tight timeout makes cold start fail intermittently.
- **Downloads go through `.part` files.** That is what makes pause/resume work (`--continue`) and
  what stops a killed provisioning run from leaving a truncated binary that looks installed.
- **Pause is really stop + resume.** The process is killed and restarted with `--continue`. Expect a
  few seconds of renegotiation; for fragmented HLS, resume granularity is per-fragment.

### Queue

`main/queue/manager.ts` owns authoritative state; the renderer's zustand store is a mirror fed by
`queue:items` (full list on state change) and `queue:progress` (per-item, throttled). Items run
`queued → downloading → merging → completed`, with `paused`/`failed`/`canceled` branches.

Retry is deliberately narrow: only errors matching `isRetryableError()` (network, 5xx) auto-retry
with backoff. "Video unavailable" and 403s surface to the user instead — looping on them hides the
real reason. An item waiting out its backoff stays `queued` but is skipped by `pump()` via
`retryTimers`.

The queue is persisted to `queue.json`; in-flight items come back as `paused` on restart since their
processes died with the app.

### Desktop integration

`main/tray.ts` owns both the tray icon and the Windows taskbar progress bar, driven from the same
queue snapshot as the UI via `sendQueueItems`. Taskbar progress takes a value in `[0,1]`; `-1`
clears it, so an idle queue must reset it or a stale bar sticks around.

The tray is constructed from the `.ico` **path**, not a `NativeImage`. The file carries 16/32/48/256
variants and Windows picks the one matching tray DPI; handing it a 256px image forces a blurry
downscale. `resources/icon.ico` is copied next to the asar via `extraResources` in
`electron-builder.yml` — it is not inside `files`, so referencing it from the asar would fail in a
packaged build.

`main/clipboard-watch.ts` polls the clipboard (Electron has no change event). Two rules hold: it
reads nothing unless `settings.watchClipboard` is on and never stores or logs non-URL content, and a
detected link is *offered* in the UI rather than inserted — silently overwriting the input someone
is typing in would be hostile.

### Renderer

Tailwind v4, configured CSS-first in `src/renderer/src/styles/theme.css` via `@theme` — there is no
`tailwind.config.js`. The accent is a two-stop gradient: only the first stop is persisted
(`settings.accent`), and `--accent`, `--accent-2`, `--accent-soft` and `--accent-line` are set on
`:root` at runtime from `ACCENT_THEMES` in `store/app.ts`. Anything gradient-colored uses inline
`style` rather than Tailwind color classes.

Views are `downloads | queue | clipboard | history | settings`, all rendered inside `App`'s single
`<main>`. Reading a link and choosing a format happens in `DownloadSheet`; the URL bar only probes
in the background so the sheet opens with the formats already in it.

Two things here are easy to get wrong:

- **Fonts are imported from `main.tsx`, not from `theme.css`.** They have to be bundled — the
  renderer runs under `default-src 'self'`, so a CDN stylesheet is simply blocked. But Tailwind's
  PostCSS plugin inlines a CSS-level `@import` itself, and the `url(./files/…)` references inside
  then resolve relative to `theme.css`: Vite emits no font files and the built stylesheet points at
  paths that do not exist. Moving them to a JS import keeps each stylesheet its own module.
- **Do not size the sidebar with paired Tailwind width utilities.** `w-[216px]` and
  `max-[960px]:w-16` have identical specificity, so the winner depends on the order Tailwind emits
  them in — and the arbitrary value came last, so the labels collapsed on cue while the column
  stayed 216px wide. The collapse is one block of real CSS (`.sidebar`, `.sidebar-item`,
  `.sidebar-wide-only`) in `theme.css` instead.

The splash (`renderer/splash.html` + `splash/main.ts`) is deliberately dependency-free with inline
styles — it must paint on the first frame. Do not import React or shared components into it.

`hooks/useLinkDrop.ts` handles dropped links. Its `preventDefault` calls are load-bearing: without
them Electron treats a dropped link as a navigation and replaces the app with that page. The
listeners are registered in the capture phase so they win over any child handler.

## Runtime layout

Everything the app writes lives under `%APPDATA%/VideoDownloader/`, so deleting that one folder is a
full reset — which is also how you test cold start:

```
bin/           yt-dlp.exe, ffmpeg.exe, ffprobe.exe   (downloaded on first launch)
cache/         ffmpeg zip staging + yt-dlp/ extractor cache (pruned at startup)
logs/main.log  main-process log — the first place to look when startup fails
settings.json  seeded with defaults on first run
queue.json     persisted queue
```

## Verifying changes

Run the app; this project is defined by behavior against live services, not by unit tests.

- **Cold start:** delete `%APPDATA%/VideoDownloader/` and launch. Both binaries should download with
  visible progress, and the main window should appear only after the probe passes. Relaunch and
  confirm the splash passes through in about a second.
- **A real download:** confirm the merged mp4 has both streams —
  `ffprobe -v error -show_entries stream=codec_type,codec_name,height <file>` should list video and
  audio (plus a png stream when thumbnail embedding is on).
- **Cancel:** cancel mid-download, then confirm no orphaned `ffmpeg.exe` survives.
- **Security spot-check:** in the renderer devtools console, `window.require` and `process` must be
  undefined.
