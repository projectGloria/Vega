import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

/**
 * Startup failures are invisible in a packaged app — there is no console to
 * read. Everything the main process does lands in logs/main.log so a user (or
 * a bug report) can say what actually happened.
 */
let logPath: string | null = null

function target(): string | null {
  if (logPath) return logPath
  try {
    const dir = join(app.getPath('userData'), 'logs')
    mkdirSync(dir, { recursive: true })
    logPath = join(dir, 'main.log')
    return logPath
  } catch {
    return null
  }
}

function write(level: string, args: unknown[]): void {
  const message = args
    .map((a) => (a instanceof Error ? a.stack ?? a.message : typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ')

  const line = new Date().toISOString() + ' [' + level + '] ' + message

  // Also to stdout so `electron .` from a terminal shows it live.
  if (level === 'error') console.error(line)
  else console.log(line)

  const path = target()
  if (!path) return
  try {
    appendFileSync(path, line + '\n', 'utf8')
  } catch {
    // Logging must never be the thing that breaks the app.
  }
}

export const log = {
  info: (...args: unknown[]) => write('info', args),
  warn: (...args: unknown[]) => write('warn', args),
  error: (...args: unknown[]) => write('error', args)
}
