import { app, Menu, Tray, nativeImage, type BrowserWindow } from 'electron'
import { existsSync } from 'node:fs'
import type { QueueItem } from '@shared/types'
import { resourcePath } from './resources'
import { log } from './log'

/**
 * Tray icon plus Windows taskbar progress. Both are driven from the same queue
 * snapshot so they can never disagree about what is happening.
 */
export class TrayController {
  private tray: Tray | null = null
  private lastTooltip = ''
  /** -1 until the first build, so the initial menu is always created. */
  private lastMenuActiveCount = -1

  constructor(
    private getWindow: () => BrowserWindow | null,
    private actions: { pauseAll(): void; resumeAll(): void; showWindow(): void }
  ) {}

  create(): void {
    if (this.tray) return

    try {
      const iconPath = resourcePath('icon.ico')

      // Hand Windows the .ico path rather than a NativeImage: the file carries
      // 16/32/48/256 variants and the platform picks the one that matches the
      // tray's DPI. Passing a 256px image instead forces a blurry downscale.
      this.tray = existsSync(iconPath)
        ? new Tray(iconPath)
        : new Tray(nativeImage.createEmpty())

      if (!existsSync(iconPath)) log.warn('tray icon missing at', iconPath)
    } catch (err) {
      // A missing tray is a cosmetic loss, never a reason to fail startup.
      log.warn('could not create tray icon', err)
      return
    }

    this.tray.setToolTip('Vega')
    this.tray.on('click', () => this.actions.showWindow())
    this.tray.on('double-click', () => this.actions.showWindow())
    this.rebuildMenu(0)
  }

  destroy(): void {
    this.tray?.destroy()
    this.tray = null
  }

  /**
   * Recomputes tray tooltip, context menu and taskbar progress from the queue.
   *
   * Windows shows the taskbar bar only for a value in [0,1]; -1 clears it, so
   * an idle queue must reset it rather than leaving a stale bar behind.
   */
  update(items: QueueItem[]): void {
    const active = items.filter((i) => i.status === 'downloading' || i.status === 'merging')
    const queued = items.filter((i) => i.status === 'queued').length

    const measurable = active.filter((i) => i.percent !== null)
    const overall =
      measurable.length > 0
        ? measurable.reduce((sum, i) => sum + (i.percent ?? 0), 0) / measurable.length / 100
        : null

    const window = this.getWindow()
    if (window && !window.isDestroyed()) {
      if (active.length === 0) {
        window.setProgressBar(-1)
      } else if (overall === null) {
        // Active but no byte totals yet (fragmented streams): indeterminate.
        window.setProgressBar(2, { mode: 'indeterminate' })
      } else {
        window.setProgressBar(overall)
      }
    }

    if (!this.tray) return

    const tooltip =
      active.length === 0
        ? queued > 0
          ? 'Vega — ' + queued + ' queued'
          : 'Vega'
        : 'Vega — ' +
          active.length +
          ' downloading' +
          (overall !== null ? ' · ' + Math.round(overall * 100) + '%' : '') +
          (queued > 0 ? ' · ' + queued + ' queued' : '')

    // setToolTip is a syscall per call; skip it when nothing changed.
    if (tooltip !== this.lastTooltip) {
      this.tray.setToolTip(tooltip)
      this.lastTooltip = tooltip
    }

    this.rebuildMenu(active.length)
  }

  private rebuildMenu(activeCount: number): void {
    if (!this.tray) return
    // The only thing the queue changes here is whether "Pause all" is enabled,
    // so rebuilding on every progress-driven emit is pure syscall churn.
    const enabled = activeCount > 0
    if (this.lastMenuActiveCount !== -1 && enabled === this.lastMenuActiveCount > 0) return
    this.lastMenuActiveCount = activeCount

    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Show Vega', click: () => this.actions.showWindow() },
        { type: 'separator' },
        {
          label: 'Pause all downloads',
          enabled,
          click: () => this.actions.pauseAll()
        },
        { label: 'Resume all', click: () => this.actions.resumeAll() },
        { type: 'separator' },
        { label: 'Quit', click: () => app.quit() }
      ])
    )
  }
}
