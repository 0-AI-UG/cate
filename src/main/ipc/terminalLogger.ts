// =============================================================================
// Terminal logger — buffers PTY output to disk per-terminal for session restore
// Uses a two-file rotation scheme: {terminalId}.log + {terminalId}.prev.log
// =============================================================================

import fs from 'fs'
import path from 'path'
import { app } from 'electron'

const MAX_LOG_SIZE = 1 * 1024 * 1024  // 1MB — triggers rotation
const FLUSH_BUFFER_SIZE = 4 * 1024    // 4KB — triggers immediate flush
const FLUSH_INTERVAL_MS = 1000        // 1s — periodic flush interval

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
  // Rotation — called synchronously inside flush() when current exceeds 1MB
  // ---------------------------------------------------------------------------

  private rotate(): void {
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
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  append(data: string): void {
    this.buffer += data
    if (this.buffer.length >= FLUSH_BUFFER_SIZE) {
      this.flush()
    }
  }

  flush(): void {
    if (this.buffer.length === 0) return

    const data = this.buffer
    this.buffer = ''

    ensureLogDir()

    const current = this.currentLogPath()

    try {
      // Check if rotation is needed before writing
      let currentSize = 0
      try {
        currentSize = fs.statSync(current).size
      } catch {
        // File doesn't exist yet — size stays 0
      }

      if (currentSize >= MAX_LOG_SIZE) {
        this.rotate()
      }

      fs.appendFileSync(current, data, 'utf-8')
    } catch {
      // If we can't write to disk, discard rather than accumulate unboundedly
    }
  }

  readAll(): string {
    this.flush()

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
    this.flush()

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
 */
export function removeLogger(terminalId: string): void {
  const logger = loggers.get(terminalId)
  if (logger) {
    logger.flush()
    // Access private stopTimer via a cast so callers don't need to know about it
    ;(logger as any).stopTimer()
    loggers.delete(terminalId)
  }
}

/**
 * Flush all active loggers — useful on app before-quit.
 */
export function flushAll(): void {
  for (const logger of loggers.values()) {
    logger.flush()
  }
}
