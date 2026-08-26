# Video Downloader

A Windows desktop app for downloading video and audio, built on [yt-dlp](https://github.com/yt-dlp/yt-dlp)
and [ffmpeg](https://ffmpeg.org/). Paste a link, pick a quality, done.

You do not need yt-dlp or ffmpeg installed — the app fetches and manages its own copies on first
launch, with a progress screen showing exactly what it is doing.

## Features

- **Format and quality picker** — one-click quality chips with size estimates, plus the full format
  table when you want a specific stream
- **Audio extraction** — MP3, M4A, Opus, FLAC, or WAV with a bitrate choice
- **Playlists** — expand a playlist, tick the items you want, queue them in one go
- **Subtitles and metadata** — embed subtitles, thumbnails as cover art, and title metadata
- **Download queue** — configurable parallel downloads, live speed and ETA, pause, resume, cancel,
  and retry, with a per-item log when something goes wrong
- **Drag and drop** — drop a link straight onto the window from your browser
- **Copied links are offered** — copy a video URL anywhere and the app suggests it, one click to
  load. It is offered, never filled in for you, and the watcher can be turned off in Settings
- **Tray and taskbar** — a tray icon with pause-all / resume-all, and live download progress on the
  Windows taskbar button
- **Self-maintaining** — keeps yt-dlp current in the background, since stale versions are the usual
  reason a download suddenly stops working

## Install

Grab the installer or the portable exe from `dist/` after building, or build it yourself:

```bash
npm install
npm run dist
```

This produces `VideoDownloader-1.0.0-x64.exe` (NSIS installer) and a portable build.

## Development

```bash
npm install
npm run dev
```

Requires Node 20+. See [CLAUDE.md](./CLAUDE.md) for architecture notes.

## Where things live

The app keeps everything it manages in `%APPDATA%\VideoDownloader\`:

| Path | What it is |
| --- | --- |
| `bin\` | yt-dlp and ffmpeg, downloaded on first launch |
| `cache\` | extractor cache, pruned automatically |
| `logs\main.log` | app log — the first place to look if startup fails |
| `settings.json` | your preferences |
| `queue.json` | the download queue, so a restart does not lose it |

Deleting that folder fully resets the app.

Downloads themselves default to `Downloads\VideoDownloader\`, changeable in Settings.

## A note on use

This is a tool for downloading media you have the right to download — your own uploads, public
domain and openly licensed works, and content whose terms permit it. Respect the terms of service of
the sites you use it with, and the rights of the people who made what you are downloading.
