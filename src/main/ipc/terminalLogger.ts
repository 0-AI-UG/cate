// =============================================================================
// Terminal logger — buffers PTY output to disk per-terminal for session restore
// Uses a two-file rotation scheme: {terminalId}.log + {terminalId}.prev.log
//
// Hot path: PTY data accumulates in an in-memory buffer and is flushed to a
// KEPT-OPEN append write stream on a ~250ms timer (or early if the buffer
// exceeds a 1MB safety cap). One file open per logger, many writes — no
// open+write+close per flush. This yields a handful of large stream.write()
// calls per second even under a heavy flood, minimizing syscalls and CPU
// wakeups for a real battery win.
//
// We track bytes-written in memory (no statSync on the hot path) and rotate
// when the counter crosses 1MB. On shutdown/read paths we drain the pending
// in-memory buffer with a synchronous appendFileSync (a stream's internal
// buffer can't be reliably drained synchronously at process exit), guaranteeing
// zero data loss on quit.
// =============================================================================

import fs from 'fs'
import path from 'path'
import { app } from 'electron'

const MAX_LOG_SIZE = 1 * 1024 * 1024     // 1MB — triggers rotation
const FLUSH_INTERVAL_MS = 250            // ~250ms — primary (time-based) flush cadence → ~4 writes/sec
const FLUSH_BUFFER_CAP = 1 * 1024 * 1024 // 1MB — size safety-cap: flush early only to bound memory

function getLogDir(): string {
  return path.join(app.getPath('userData'), 'TerminalLogs')
}

function ensureLogDir(): void {
  const dir = getLogDir()
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

// =============================================================================
// TerminalLogger class
// =============================================================================

export class TerminalLogger {
  private readonly terminalId: string
  private buffer: string = ''
  private flushTimer: ReturnType<typeof setInterval> | null = null
  // Bytes written to the current (un-rotated) log file, tracked in memory so the
  // hot path never has to statSync. -1 means "not yet known" (we lazily seed it
  // from the real file size on the first flush after construction).
  private currentBytes: number = -1
  // Kept-open append stream for the current log file. Opened lazily on first
  // write and reused for every subsequent write until rotation/dispose.
  private stream: fs.WriteStream | null = null
  // The path the open stream is writing to (so we can detect path changes).
  private streamPath: string | null = null
  // Set if the stream emits an error — we stop trusting the stream and fall
  // back to synchronous appends so a disk/EPIPE error can't take down main.
  private broken: boolean = false

  constructor(terminalId: string) {
    this.terminalId = terminalId
    ensureLogDir()
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS)
  }

  // ---------------------------------------------------------------------------
  // Path helpers
  // ---------------------------------------------------------------------------

  private currentLogPath(): string {
    return path.join(TerminalLogger.getLogDir(), `${this.terminalId}.log`)
  }

  private prevLogPath(): string {
    return path.join(TerminalLogger.getLogDir(), `${this.terminalId}.prev.log`)
  }

  // ---------------------------------------------------------------------------
  // Byte-counter seeding — lazily read the on-disk size once so the in-memory
  // counter starts accurate (e.g. when reattaching to an existing log file).
  // ---------------------------------------------------------------------------

  private ensureByteCounter(): void {
    if (this.currentBytes >= 0) return
    try {
      this.currentBytes = fs.statSync(this.currentLogPath()).size
    } catch {
      this.currentBytes = 0  // File doesn't exist yet
    }
  }

  // ---------------------------------------------------------------------------
  // Stream lifecycle — one open per logger, kept open across writes.
  // ---------------------------------------------------------------------------

  private ensureStream(): fs.WriteStream | null {
    const current = this.currentLogPath()
    if (this.stream !== null && this.streamPath === current) {
      return this.stream
    }
    // Open a fresh append stream lazily (first write) or after a path change.
    try {
      ensureLogDir()
      const stream = fs.createWriteStream(current, { flags: 'a' })
      stream.on('error', (err) => {
        // Disk full, EPIPE, permissions, etc. Mark broken and tear the stream
        // down so we fall back to synchronous appends instead of crashing main.
        console.error(`[terminalLogger] stream error for ${this.terminalId}:`, err)
        this.broken = true
        if (this.stream === stream) {
          this.stream = null
          this.streamPath = null
        }
      })
      this.stream = stream
      this.streamPath = current
      return stream
    } catch (err) {
      console.error(`[terminalLogger] failed to open stream for ${this.terminalId}:`, err)
      this.broken = true
      this.stream = null
      this.streamPath = null
      return null
    }
  }

  // Close the current stream (best-effort). Used on rotation and dispose.
  private closeStream(): void {
    if (this.stream !== null) {
      const stream = this.stream
      this.stream = null
      this.streamPath = null
      try {
        stream.end()
      } catch {
        // Best-effort
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Rotation — called when the in-memory byte counter crosses 1MB.
  // Flushes + ends the current stream, renames current → prev, then a fresh
  // stream is opened lazily on the next write. Buffered in-memory data is
  // written BEFORE rotation by the caller, so nothing is lost across a rotate.
  // ---------------------------------------------------------------------------

  private rotate(): void {
    // End the open stream first so the renamed file is complete on disk.
    this.closeStream()

    const current = this.currentLogPath()
    const prev = this.prevLogPath()

    try {
      if (fs.existsSync(prev)) {
        fs.unlinkSync(prev)
      }
    } catch {
      // Best-effort; continue even if prev removal fails
    }

    try {
      if (fs.existsSync(current)) {
        fs.renameSync(current, prev)
      }
    } catch {
      // Best-effort; if rename fails we'll just overwrite current
    }

    this.currentBytes = 0
    // Next ensureStream() opens a fresh stream on the (now empty) current path.
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  append(data: string): void {
    if (data.length === 0) return
    this.buffer += data
    // Size safety-cap only: flush early to bound memory under a sustained flood.
    // Steady-state flushing is driven by the ~250ms timer, so this rarely fires.
    if (this.buffer.length >= FLUSH_BUFFER_CAP) {
      this.flush()
    }
  }

  // Async, batched flush used on the hot path (timer + size cap). Writes the
  // accumulated buffer to the kept-open stream in one stream.write() call.
  flush(): void {
    if (this.buffer.length === 0) return

    const data = this.buffer
    this.buffer = ''
    const byteLen = Buffer.byteLength(data, 'utf-8')

    this.ensureByteCounter()
    // Rotate (if needed) BEFORE writing this chunk. The in-memory buffer is
    // already captured in `data`, so it lands on the fresh post-rotation file.
    if (this.currentBytes >= MAX_LOG_SIZE) {
      this.rotate()
    }

    if (this.broken) {
      // Stream is unusable — fall back to a synchronous append so we still
      // persist data without risking another stream error.
      this.syncAppend(data, byteLen)
      return
    }

    const stream = this.ensureStream()
    if (stream === null) {
      this.syncAppend(data, byteLen)
      return
    }

    try {
      stream.write(data)
      this.currentBytes += byteLen
    } catch (err) {
      console.error(`[terminalLogger] write failed for ${this.terminalId}:`, err)
      this.broken = true
      this.closeStream()
      this.syncAppend(data, byteLen)
    }
  }

  // Synchronous append to the current path — used by the read/shutdown paths and
  // as a fallback when the stream is broken. NOT used on the normal hot path.
  private syncAppend(data: string, byteLen: number): void {
    try {
      ensureLogDir()
      fs.appendFileSync(this.currentLogPath(), data, 'utf-8')
      this.currentBytes += byteLen
    } catch {
      // If we can't write to disk, discard rather than accumulate unboundedly
    }
  }

  // Synchronous flush — drains the pending in-memory buffer to disk via
  // appendFileSync. Used on read/shutdown/teardown so buffered data is on disk
  // before the file is read or the process exits. A kept-open stream's internal
  // buffer can't be reliably drained synchronously, so we bypass it here and
  // write directly to the current path. Public so flushAll() can drain on quit
  // WITHOUT tearing the logger down (the app keeps running between the deferred
  // before-quit pass and the final quit, and may still emit terminal output).
  flushSync(): void {
    if (this.buffer.length === 0) return

    const data = this.buffer
    this.buffer = ''
    const byteLen = Buffer.byteLength(data, 'utf-8')

    this.ensureByteCounter()
    if (this.currentBytes >= MAX_LOG_SIZE) {
      this.rotate()
    }

    this.syncAppend(data, byteLen)
  }

  readAll(): string {
    this.flushSync()

    let result = ''

    const prev = this.prevLogPath()
    try {
      result += fs.readFileSync(prev, 'utf-8')
    } catch {
      // File doesn't exist or unreadable — treat as empty
    }

    const current = this.currentLogPath()
    try {
      result += fs.readFileSync(current, 'utf-8')
    } catch {
      // File doesn't exist or unreadable — treat as empty
    }

    return result
  }

  delete(): void {
    this.flushSync()
    this.closeStream()

    for (const logPath of [this.prevLogPath(), this.currentLogPath()]) {
      try {
        if (fs.existsSync(logPath)) {
          fs.unlinkSync(logPath)
        }
      } catch {
        // Best-effort removal
      }
    }
  }

  // Drain any buffered data to disk synchronously, close the open stream, and
  // stop the periodic timer. Called from removeLogger / disposeAll on teardown +
  // app quit. We flush the in-memory buffer synchronously (appendFileSync) so no
  // data is lost, then end() the stream — we do NOT rely on async stream
  // flushing during quit.
  dispose(): void {
    this.flushSync()
    this.closeStream()
    this.stopTimer()
  }

  // Stop the periodic flush timer (called when removing the logger from the map)
  private stopTimer(): void {
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
  }

  // ---------------------------------------------------------------------------
  // Static helpers
  // ---------------------------------------------------------------------------

  static getLogDir(): string {
    return getLogDir()
  }

  /**
   * Remove log files for any terminalId not present in activeIds.
   * Inspects all *.log and *.prev.log files in the log directory.
   */
  static pruneOrphaned(activeIds: Set<string>): void {
    const dir = getLogDir()

    let entries: string[]
    try {
      entries = fs.readdirSync(dir)
    } catch {
      return // Directory doesn't exist — nothing to prune
    }

    for (const entry of entries) {
      let terminalId: string | null = null

      if (entry.endsWith('.prev.log')) {
        terminalId = entry.slice(0, -'.prev.log'.length)
      } else if (entry.endsWith('.log')) {
        terminalId = entry.slice(0, -'.log'.length)
      }

      if (terminalId !== null && !activeIds.has(terminalId)) {
        try {
          fs.unlinkSync(path.join(dir, entry))
        } catch {
          // Best-effort removal
        }
      }
    }
  }
}

// =============================================================================
// Module-level logger registry
// =============================================================================

export const loggers: Map<string, TerminalLogger> = new Map()

export function getOrCreateLogger(terminalId: string): TerminalLogger {
  let logger = loggers.get(terminalId)
  if (!logger) {
    logger = new TerminalLogger(terminalId)
    loggers.set(terminalId, logger)
  }
  return logger
}

/**
 * Flush and remove the logger from the map without deleting log files on disk.
 * Call this when a terminal process exits but you still want to retain the logs.
 * Drains synchronously so no buffered output is lost.
 */
export function removeLogger(terminalId: string): void {
  const logger = loggers.get(terminalId)
  if (logger) {
    logger.dispose()  // sync flush + close stream + stop timer
    loggers.delete(terminalId)
  }
}

/**
 * Flush all active loggers synchronously — called on app before-quit so that
 * buffered output reaches disk before the process exits. This only drains the
 * in-memory buffer with appendFileSync; it does NOT stop timers or close
 * streams, because the app keeps running after this (it defers quit to let the
 * renderer save the session, during which terminals may still emit output).
 * Full teardown happens later via disposeAll().
 */
export function flushAll(): void {
  for (const logger of loggers.values()) {
    logger.flushSync()
  }
}

/**
 * Flush (synchronously), close streams, stop timers, and clear all loggers —
 * call on app quit to prevent leaked setInterval timers / open file handles and
 * to guarantee no buffered data is lost.
 */
export function disposeAll(): void {
  for (const [id, logger] of loggers) {
    logger.dispose()  // sync flush + close stream + stop timer
    loggers.delete(id)
  }
}
