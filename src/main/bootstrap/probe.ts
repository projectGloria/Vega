import { execFile } from 'node:child_process'
import { access, constants, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Runs a binary with `args` and returns trimmed stdout, or throws.
 *
 * The timeout is deliberately generous: yt-dlp.exe is a PyInstaller bundle that
 * unpacks itself on first execution, and a freshly downloaded exe also gets a
 * full Defender scan on its first run. On a cold machine that can take far
 * longer than a normal `--version` call suggests.
 */
function run(exe: string, args: string[], timeoutMs = 90_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      exe,
      args,
      { timeout: timeoutMs, windowsHide: true, shell: false },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(err.message + (stderr ? '\n' + stderr.slice(0, 400) : '')))
          return
        }
        resolve(stdout.toString().trim())
      }
    )
  })
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/**
 * A binary being present is not the same as it working — a truncated or
 * quarantined exe exists but will not run. Both bootstrap and the settings
 * panel use this, so a broken binary surfaces as an error, not a mystery.
 */
export async function probeYtdlp(exe: string): Promise<string> {
  return run(exe, ['--version'])
}

export async function probeFfmpeg(exe: string): Promise<string> {
  const out = await run(exe, ['-version'])
  const first = out.split('\n')[0] ?? ''
  const match = first.match(/ffmpeg version (\S+)/)
  return match ? match[1] : first.slice(0, 60)
}

const CACHE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000
const CACHE_MAX_BYTES = 200 * 1024 * 1024

/**
 * Drops stale cache entries so the folder cannot grow without bound. Returns
 * the number of bytes reclaimed. Failures here are non-fatal by design: a
 * cache we cannot prune must never block startup.
 */
export async function pruneCache(cacheDir: string): Promise<number> {
  let reclaimed = 0
  const now = Date.now()

  let entries: string[]
  try {
    entries = await readdir(cacheDir)
  } catch {
    return 0
  }

  const files: { path: string; size: number; mtime: number }[] = []

  for (const name of entries) {
    const path = join(cacheDir, name)
    try {
      const s = await stat(path)
      if (!s.isFile()) continue
      if (now - s.mtimeMs > CACHE_MAX_AGE_MS) {
        await rm(path, { force: true })
        reclaimed += s.size
      } else {
        files.push({ path, size: s.size, mtime: s.mtimeMs })
      }
    } catch {
      // A file that vanished or is locked is not our problem here.
    }
  }

  let total = files.reduce((sum, f) => sum + f.size, 0)
  if (total <= CACHE_MAX_BYTES) return reclaimed

  // Over budget: evict oldest first until back under the cap.
  files.sort((a, b) => a.mtime - b.mtime)
  for (const f of files) {
    if (total <= CACHE_MAX_BYTES) break
    try {
      await rm(f.path, { force: true })
      total -= f.size
      reclaimed += f.size
    } catch {
      // Skip locked files.
    }
  }

  return reclaimed
}

/** Clears any `.part` files left behind by a download killed mid-flight. */
export async function clearStaleParts(dir: string): Promise<void> {
  try {
    const entries = await readdir(dir)
    await Promise.all(
      entries
        .filter((n) => n.endsWith('.part'))
        .map((n) => rm(join(dir, n), { force: true }).catch(() => {}))
    )
  } catch {
    // Directory may not exist yet on a first run.
  }
}
