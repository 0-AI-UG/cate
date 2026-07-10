// =============================================================================
// jsonStateFile — a reusable "JSON file is the source of truth" store, lifted
// from the pattern proven by ./settingsFile (settings.json).
//
// Each instance owns one hand-editable `<userData>/<filename>` and provides:
//   - Synchronous load at startup (so main can read state before any window).
//   - An authoritative in-memory copy, always merged over `defaults` so reads
//     never miss a field.
//   - Debounced + atomic writes (tmp + rename), pretty-printed so the file
//     stays comfortably hand-editable.
//   - A chokidar watcher that detects EXTERNAL edits and reports the new state.
//     Our own programmatic writes are suppressed by content comparison.
//   - Corrupt-file quarantine: an unparseable file is copied aside as
//     `<filename>.corrupt-<ts>` before we fall back to defaults, mirroring the
//     resilience electron-store gave us via clearInvalidConfig.
//
// `normalize` is the single authority for a store's shape: it takes the raw
// parsed JSON and the defaults and returns a complete, validated value. It must
// never throw — a malformed hand-edit should degrade to defaults, not crash.
// =============================================================================

import { app } from 'electron'
import fs from 'fs/promises'
import fsSync from 'fs'
import path from 'path'
import { watch } from 'chokidar'
import log from './logger'
import { writeJsonAtomic, writeJsonAtomicSync } from './writeJsonAtomic'
import { quarantineCorruptFile } from './quarantineCorruptFile'
import { createJsonStateStore } from './jsonStateStore'

export interface JsonStateFileOptions<T> {
  /** File name, joined under `dir` (or `app.getPath('userData')` when omitted). */
  filename: string
  /** Absolute directory the file lives in. Defaults to `app.getPath('userData')`
   *  — pass this for project-local files (e.g. `<project>/.cate/...`). */
  dir?: string
  /** Complete default value, used when the file is absent/empty/corrupt. */
  defaults: T
  /** Validate + normalize raw parsed JSON into a complete T. Never throws. */
  normalize: (parsed: unknown, defaults: T) => T
}

export interface JsonStateFile<T> {
  /** Sync load from disk (idempotent). Returns the current value. */
  load(): T
  /** Current in-memory value (always complete). */
  get(): T
  /** Replace the whole value and persist via a debounced atomic write. */
  set(next: T): void
  /** Functional update over the current value. */
  update(fn: (current: T) => T): void
  /** Absolute path of the backing file. */
  getPath(): string
  /** Ensure the file exists on disk, returning its path. */
  ensureFile(): Promise<string>
  /** Watch for EXTERNAL edits; `onExternal` fires with the new value. */
  startWatching(onExternal: (next: T) => void): void
  stopWatching(): void
  /** Flush a pending debounced write synchronously (call on quit). */
  flushPendingWritesSync(): void
}

export function createJsonStateFile<T>(options: JsonStateFileOptions<T>): JsonStateFile<T> {
  const { filename, dir, defaults, normalize } = options
  let stopSubscription: (() => void) | null = null

  function filePath(): string {
    return path.join(dir ?? app.getPath('userData'), filename)
  }

  /** Copy an unparseable file aside so a corrupt hand-edit / crash-mid-write is
   *  preserved for recovery instead of silently overwritten with defaults. */
  function quarantineCorrupt(): void {
    const backup = quarantineCorruptFile(filePath())
    if (backup) {
      log.error('[jsonStateFile] %s is corrupt; backed up to %s and using defaults', filename, backup)
    } else {
      log.warn('[jsonStateFile] corrupt backup for %s failed', filename)
    }
  }

  const state = createJsonStateStore<T>({
    defaults,
    normalize,
    backend: {
      readSync: () => {
        const p = filePath()
        return fsSync.existsSync(p) ? fsSync.readFileSync(p, 'utf-8') : null
      },
      read: async () => {
        try { return await fs.readFile(filePath(), 'utf-8') } catch { return null }
      },
      write: async (value) => { await writeJsonAtomic(filePath(), value) },
      writeSync: (value) => { writeJsonAtomicSync(filePath(), value) },
      watch: (onChange) => {
        const watcher = watch(filePath(), { ignoreInitial: true })
        watcher.on('change', onChange)
        watcher.on('add', onChange)
        watcher.on('error', (err) => log.warn('[jsonStateFile] watcher error for %s: %O', filename, err))
        return () => { void watcher.close() }
      },
    },
    onInvalid: (phase) => {
      if (phase === 'load') quarantineCorrupt()
      else log.warn('[jsonStateFile] external edit of %s is not valid JSON — keeping current', filename)
    },
    onError: (operation, err) => {
      log.warn('[jsonStateFile] %s of %s failed: %O', operation, filename, err)
    },
  })

  function load(): T {
    // filePath() and the sync read are contained by the shared state core, so a
    // context without electron's app degrades to defaults instead of throwing.
    return state.loadSync()
  }

  async function ensureFile(): Promise<string> {
    load()
    const p = filePath()
    try {
      await fs.access(p)
    } catch {
      await state.flush(true)
    }
    return p
  }

  function startWatching(onExternal: (next: T) => void): void {
    if (stopSubscription) return
    load()
    stopSubscription = state.subscribe((next, origin) => {
      if (origin === 'external') onExternal(next)
    })
  }

  function stopWatching(): void {
    stopSubscription?.()
    stopSubscription = null
    void state.flush()
  }

  function flushPendingWritesSync(): void {
    state.flushSync()
  }

  return {
    load,
    get: () => { load(); return state.get() },
    set: (next) => { load(); state.set(next) },
    update: (fn) => { load(); state.update(fn) },
    getPath: filePath,
    ensureFile,
    startWatching,
    stopWatching,
    flushPendingWritesSync,
  }
}
