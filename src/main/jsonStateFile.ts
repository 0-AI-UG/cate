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
import { watch, type FSWatcher } from 'chokidar'
import log from './logger'
import { writeJsonAtomic, writeJsonAtomicSync } from './writeJsonAtomic'
import { quarantineCorruptFile } from './quarantineCorruptFile'

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

const WRITE_DEBOUNCE_MS = 150

export function createJsonStateFile<T>(options: JsonStateFileOptions<T>): JsonStateFile<T> {
  const { filename, dir, defaults, normalize } = options

  // Authoritative in-memory value — defaults until loaded, always complete.
  let current: T = defaults
  let loaded = false
  // The exact string we last wrote; the watcher compares against it to ignore
  // the change event our own write produces.
  let lastWrittenContent = ''
  let watcher: FSWatcher | null = null
  let writeTimer: ReturnType<typeof setTimeout> | null = null
  // Tail of the serialized async-flush chain. Flushes never overlap: each waits
  // for the previous to finish before writing. Without this, two debounced
  // flushes could interleave so the OLDER content lands last on disk while
  // `lastWrittenContent` holds the newer — the watcher then "corrects" in-memory
  // state back to the stale snapshot.
  let flushChain: Promise<void> = Promise.resolve()
  let flushInFlight = false

  function filePath(): string {
    return path.join(dir ?? app.getPath('userData'), filename)
  }

  function serialize(value: T): string {
    return JSON.stringify(value, null, 2) + '\n'
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

  function load(): T {
    if (loaded) return current
    try {
      // filePath() is inside the try so a context without electron's `app`
      // (e.g. a non-electron unit test that reads a setting transitively)
      // degrades to defaults instead of throwing.
      const p = filePath()
      if (fsSync.existsSync(p)) {
        const raw = fsSync.readFileSync(p, 'utf-8')
        try {
          const parsed = JSON.parse(raw)
          current = normalize(parsed, defaults)
          lastWrittenContent = raw
        } catch {
          quarantineCorrupt()
          current = defaults
        }
      }
    } catch (err) {
      log.warn('[jsonStateFile] sync load of %s failed: %O', filename, err)
      current = defaults
    }
    loaded = true
    return current
  }

  function writeSync(): void {
    const content = serialize(current)
    try {
      writeJsonAtomicSync(filePath(), current)
      lastWrittenContent = content
    } catch (err) {
      log.warn('[jsonStateFile] sync write of %s failed: %O', filename, err)
    }
  }

  // One serialized flush: snapshot `current` at write time (not schedule time) and
  // append to the chain so writes can't interleave. Returns the chain tail so
  // callers (ensureFile / stopWatching) can await the latest flush.
  function flushWrite(): Promise<void> {
    writeTimer = null
    flushInFlight = true
    flushChain = flushChain.then(async () => {
      const content = serialize(current)
      // Record before the write so a watcher event racing the rename still matches.
      lastWrittenContent = content
      try {
        await writeJsonAtomic(filePath(), current)
      } catch (err) {
        log.warn('[jsonStateFile] write of %s failed: %O', filename, err)
      }
    })
    const settled = flushChain
    settled.finally(() => { if (flushChain === settled) flushInFlight = false })
    return settled
  }

  function scheduleWrite(): void {
    if (writeTimer) return
    writeTimer = setTimeout(() => { void flushWrite() }, WRITE_DEBOUNCE_MS)
  }

  function set(next: T): void {
    load()
    current = next
    scheduleWrite()
  }

  function update(fn: (current: T) => T): void {
    load()
    current = fn(current)
    scheduleWrite()
  }

  async function ensureFile(): Promise<string> {
    load()
    const p = filePath()
    try {
      await fs.access(p)
    } catch {
      await flushWrite()
    }
    return p
  }

  function startWatching(onExternal: (next: T) => void): void {
    if (watcher) return
    load()
    const p = filePath()
    watcher = watch(p, { ignoreInitial: true })

    const handle = async (): Promise<void> => {
      let raw: string
      try {
        raw = await fs.readFile(p, 'utf-8')
      } catch {
        return // transient (mid-rename) — the trailing event settles it
      }
      if (raw === lastWrittenContent) return // our own write — ignore the echo

      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        log.warn('[jsonStateFile] external edit of %s is not valid JSON — keeping current', filename)
        return
      }
      const next = normalize(parsed, defaults)
      lastWrittenContent = raw
      if (JSON.stringify(next) === JSON.stringify(current)) return
      current = next
      onExternal(current)
    }

    watcher.on('change', () => { void handle() })
    watcher.on('add', () => { void handle() })
    watcher.on('error', (err) => log.warn('[jsonStateFile] watcher error for %s: %O', filename, err))
  }

  function stopWatching(): void {
    if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; void flushWrite() }
    if (watcher) { void watcher.close(); watcher = null }
  }

  function flushPendingWritesSync(): void {
    if (writeTimer) {
      clearTimeout(writeTimer)
      writeTimer = null
    } else if (!flushInFlight && serialize(current) === lastWrittenContent) {
      // No debounced timer, no async flush mid-await, and the latest value is
      // already durable — nothing to persist.
      return
    }
    // A timer was pending, an async flush is still mid-await (its rename may not
    // have landed), or `current` moved past the last durable write. The process
    // is about to exit, so persist `current` synchronously: the sync rename is
    // last-writer-wins over any in-flight async rename and guarantees the final
    // pre-quit state survives.
    writeSync()
  }

  return {
    load,
    get: () => { load(); return current },
    set,
    update,
    getPath: filePath,
    ensureFile,
    startWatching,
    stopWatching,
    flushPendingWritesSync,
  }
}
