// =============================================================================
// jsonFileStore — tiny atomic JSON read/write helper used by small per-feature
// state files under <userData>/ (analytics state, install ID, etc.).
// Not a replacement for electron-store; intended for self-contained,
// schema-light files that don't belong in the user-facing settings store.
// =============================================================================

import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import log from './logger'
import { writeJsonAtomicSync } from './writeJsonAtomic'

function fullPath(filename: string): string {
  return path.join(app.getPath('userData'), filename)
}

/** Read and JSON.parse a file under userData/. Returns the fallback on any failure. */
export function readJsonFile<T>(filename: string, fallback: T): T {
  const p = fullPath(filename)
  try {
    if (!fs.existsSync(p)) return fallback
    const raw = fs.readFileSync(p, 'utf-8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') return parsed as T
    return fallback
  } catch (err) {
    log.warn('[jsonFileStore] read %s failed: %s', filename, err instanceof Error ? err.message : String(err))
    return fallback
  }
}

/** Atomically write a JSON value to a file under userData/. Logs on failure. */
export function writeJsonFile(filename: string, value: unknown): void {
  try {
    writeJsonAtomicSync(fullPath(filename), value)
  } catch (err) {
    log.warn('[jsonFileStore] write %s failed: %s', filename, err instanceof Error ? err.message : String(err))
  }
}

/** Read raw text from a file under userData/. Returns null when missing. */
export function readTextFile(filename: string): string | null {
  try {
    const p = fullPath(filename)
    if (!fs.existsSync(p)) return null
    return fs.readFileSync(p, 'utf-8')
  } catch (err) {
    log.warn('[jsonFileStore] readText %s failed: %s', filename, err instanceof Error ? err.message : String(err))
    return null
  }
}

/** Atomically write raw text to a file under userData/. */
export function writeTextFile(filename: string, text: string): void {
  const p = fullPath(filename)
  const tmp = p + '.tmp'
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(tmp, text, 'utf-8')
    fs.renameSync(tmp, p)
  } catch (err) {
    log.warn('[jsonFileStore] writeText %s failed: %s', filename, err instanceof Error ? err.message : String(err))
    try { fs.unlinkSync(tmp) } catch { /* noop */ }
  }
}

/** Append a line (newline-terminated) to a file under userData/. Used for jsonl buffers. */
export function appendLine(filename: string, line: string): void {
  const p = fullPath(filename)
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.appendFileSync(p, line.endsWith('\n') ? line : line + '\n', 'utf-8')
  } catch (err) {
    log.warn('[jsonFileStore] append %s failed: %s', filename, err instanceof Error ? err.message : String(err))
  }
}

/** Remove a file under userData/ if it exists. Errors are swallowed (logged). */
export function removeFile(filename: string): void {
  try {
    const p = fullPath(filename)
    if (fs.existsSync(p)) fs.unlinkSync(p)
  } catch (err) {
    log.warn('[jsonFileStore] remove %s failed: %s', filename, err instanceof Error ? err.message : String(err))
  }
}
