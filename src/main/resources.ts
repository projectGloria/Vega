import { app } from 'electron'
import { join } from 'node:path'

/**
 * Static assets live in different places in dev and in a packaged build:
 * electron-builder copies `extraResources` next to the asar, while in dev they
 * are still in the project's resources/ folder.
 */
export function resourcePath(name: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, name)
    : join(app.getAppPath(), 'resources', name)
}
