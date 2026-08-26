import { spawn, execFile, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'

/** stdin is intentionally 'ignore': yt-dlp must never wait on input we cannot give. */
type PipedChild = ChildProcessByStdio<null, Readable, Readable>

export interface RunHandle {
  /** Resolves with the exit code once the process and its children are gone. */
  done: Promise<number | null>
  /** Kills the whole process tree. Safe to call more than once. */
  kill(): void
  /** True once kill() has been requested, so callers can distinguish cancel from crash. */
  readonly killed: boolean
}

export interface RunOptions {
  onStdoutLine?: (line: string) => void
  onStderrLine?: (line: string) => void
}

/**
 * Kills a process *tree*.
 *
 * yt-dlp spawns ffmpeg as a child during merges and audio extraction. Killing
 * only the yt-dlp PID orphans that ffmpeg, which then keeps running — pinning a
 * core and holding the output file open. On Windows the reliable fix is
 * taskkill with /T (tree) and /F (force).
 */
function killTree(pid: number): void {
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {
      // A non-zero exit here just means the tree was already gone.
    })
  } else {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // Already dead.
      }
    }
  }
}

/** Splits a stream into complete lines, buffering partial tail chunks. */
function lineReader(onLine: (line: string) => void): (chunk: Buffer) => void {
  let buffer = ''
  return (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    // yt-dlp still emits \r within some progress output; treat both as breaks.
    const lines = buffer.split(/\r\n|\n|\r/)
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed) onLine(trimmed)
    }
  }
}

/**
 * Spawns a binary with an argument array and `shell: false`.
 *
 * Never switch this to a command string: titles and URLs come from the network
 * and from user paste, and a shell would interpret `&`, `|`, and `$()` in them.
 */
export function run(exe: string, args: string[], options: RunOptions = {}): RunHandle {
  let child: PipedChild
  try {
    child = spawn(exe, args, {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (err) {
    return {
      done: Promise.reject(err),
      kill: () => {},
      killed: false
    }
  }

  let killed = false

  if (options.onStdoutLine) child.stdout.on('data', lineReader(options.onStdoutLine))
  if (options.onStderrLine) child.stderr.on('data', lineReader(options.onStderrLine))

  const done = new Promise<number | null>((resolve, reject) => {
    child.on('error', (err) => reject(err))
    child.on('close', (code) => resolve(code))
  })

  return {
    done,
    kill() {
      if (killed) return
      killed = true
      if (child.pid) killTree(child.pid)
    },
    get killed() {
      return killed
    }
  }
}

/** Collects full stdout from a short-lived call (metadata probes, --version). */
export function runCapture(
  exe: string,
  args: string[],
  timeoutMs = 90_000
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const stdoutChunks: string[] = []
    const stderrChunks: string[] = []

    const handle = run(exe, args, {
      onStdoutLine: (line) => stdoutChunks.push(line),
      onStderrLine: (line) => stderrChunks.push(line)
    })

    const timer = setTimeout(() => {
      handle.kill()
      reject(new Error('Timed out after ' + Math.round(timeoutMs / 1000) + 's'))
    }, timeoutMs)

    handle.done.then(
      (code) => {
        clearTimeout(timer)
        const stdout = stdoutChunks.join('\n')
        const stderr = stderrChunks.join('\n')
        if (code === 0) {
          resolve({ stdout, stderr })
        } else {
          reject(new Error(stderr || 'Exited with code ' + code))
        }
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}
