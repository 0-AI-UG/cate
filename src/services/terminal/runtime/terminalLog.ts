// The terminal log in `<data>/terminal-logs/`, per panel:
//   <key>.log, <key>.prev.log  raw output, rotated at 1 MB
//   <key>.scrollback           the serialized screen, written when the PTY
//                              exits or the daemon stops
// A restore prefers the scrollback (a clean stop) and falls back to the raw
// log (the daemon died). Output collects in memory and goes to a kept-open
// append stream every 250 ms; teardown drains synchronously so nothing is lost.

import fs from 'node:fs'
import path from 'node:path'

const MAX_LOG_SIZE = 1024 * 1024
const FLUSH_INTERVAL_MS = 250
const FLUSH_BUFFER_CAP = 1024 * 1024

export function isSafeLogKey(key: string): boolean {
  return /^[A-Za-z0-9._-]{1,200}$/.test(key) && key !== '.' && key !== '..'
}

function files(dir: string, key: string) {
  return {
    current: path.join(dir, `${key}.log`),
    prev: path.join(dir, `${key}.prev.log`),
    scrollback: path.join(dir, `${key}.scrollback`),
  }
}

function readOr(file: string): string {
  try { return fs.readFileSync(file, 'utf-8') } catch { return '' }
}

/** What a restore shows: the saved screen, else the raw output. */
export function readSavedScreen(dir: string, key: string): string {
  const f = files(dir, key)
  return readOr(f.scrollback) || readOr(f.prev) + readOr(f.current)
}

export function removeLogFiles(dir: string, key: string): void {
  for (const file of Object.values(files(dir, key))) {
    try { fs.rmSync(file, { force: true }) } catch { /* best effort */ }
  }
}

export class TerminalLog {
  private readonly paths: ReturnType<typeof files>
  private buffer = ''
  private timer: ReturnType<typeof setInterval> | null
  private bytes = -1
  private stream: fs.WriteStream | null = null
  private broken = false

  constructor(private readonly dir: string, readonly key: string) {
    this.paths = files(dir, key)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    this.timer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS)
    this.timer.unref?.()
  }

  append(data: string): void {
    if (!data || !this.timer) return
    this.buffer += data
    if (this.buffer.length >= FLUSH_BUFFER_CAP) this.flush()
  }

  flush(): void {
    const data = this.take()
    if (data === null) return
    if (this.broken) return this.syncAppend(data)
    const stream = this.openStream()
    if (!stream) return this.syncAppend(data)
    stream.write(data)
    this.bytes += Buffer.byteLength(data, 'utf-8')
  }

  flushSync(): void {
    const data = this.take()
    if (data !== null) this.syncAppend(data)
  }

  writeScrollbackSync(screen: string): void {
    try {
      fs.writeFileSync(this.paths.scrollback, screen, { encoding: 'utf-8', mode: 0o600 })
    } catch { /* best effort */ }
  }

  /** Drops the scrollback of a previous run; this run's is written at exit. */
  clearScrollback(): void {
    try { fs.rmSync(this.paths.scrollback, { force: true }) } catch { /* best effort */ }
  }

  dispose(): void {
    this.flushSync()
    this.closeStream()
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Takes the buffered output, rotating first when the file is full. */
  private take(): string | null {
    if (!this.buffer) return null
    const data = this.buffer
    this.buffer = ''
    if (this.bytes < 0) {
      try { this.bytes = fs.statSync(this.paths.current).size } catch { this.bytes = 0 }
    }
    if (this.bytes >= MAX_LOG_SIZE) this.rotate()
    return data
  }

  private openStream(): fs.WriteStream | null {
    if (this.stream) return this.stream
    try {
      const stream = fs.createWriteStream(this.paths.current, { flags: 'a', mode: 0o600 })
      stream.on('error', () => {
        this.broken = true
        if (this.stream === stream) this.stream = null
      })
      this.stream = stream
      return stream
    } catch {
      this.broken = true
      return null
    }
  }

  private closeStream(): void {
    const stream = this.stream
    this.stream = null
    try { stream?.end() } catch { /* best effort */ }
  }

  private rotate(): void {
    this.closeStream()
    try { fs.rmSync(this.paths.prev, { force: true }) } catch { /* best effort */ }
    try { fs.renameSync(this.paths.current, this.paths.prev) } catch { /* nothing to rotate */ }
    this.bytes = 0
  }

  private syncAppend(data: string): void {
    try {
      fs.appendFileSync(this.paths.current, data, { encoding: 'utf-8', mode: 0o600 })
      this.bytes += Buffer.byteLength(data, 'utf-8')
    } catch { /* disk trouble: drop rather than grow without bound */ }
  }
}
