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

export interface JsonStateFileOptions<T> {
  /** File name under `app.getPath('userData')`. */
  filename: string
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
  const { filename, defaults, normalize } = options

  // Authoritative in-memory value — defaults until loaded, always complete.
  let current: T = defaults
  let loaded = false
  // The exact string we last wrote; the watcher compares against it to ignore
  // the change event our own write produces.
  let lastWrittenContent = ''
  let watcher: FSWatcher | null = null
  let writeTimer: ReturnType<typeof setTimeout> | null = null

  function filePath(): string {
    return path.join(app.getPath('userData'), filename)
  }

  function serialize(value: T): string {
    return JSON.stringify(value, null, 2) + '\n'
  }

  /** Copy an unparseable file aside so a corrupt hand-edit / crash-mid-write is
   *  preserved for recovery instead of silently overwritten with defaults. */
  function quarantineCorruptFile(): void {
    try {
      const p = filePath()
      const backup = `${p}.corrupt-${Date.now()}`
      fsSync.copyFileSync(p, backup)
      log.error('[jsonStateFile] %s is corrupt; backed up to %s and using defaults', filename, backup)
    } catch (err) {
      log.warn('[jsonStateFile] corrupt backup for %s failed: %O', filename, err)
    }
  }

  function load(): T {
    if (loaded) return current
    const p = filePath()
    try {
      if (fsSync.existsSync(p)) {
        const raw = fsSync.readFileSync(p, 'utf-8')
        try {
          const parsed = JSON.parse(raw)
          current = normalize(parsed, defaults)
          lastWrittenContent = raw
        } catch {
          quarantineCorruptFile()
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
      const p = filePath()
      fsSync.mkdirSync(path.dirname(p), { recursive: true })
      fsSync.writeFileSync(p, content, 'utf-8')
      lastWrittenContent = content
    } catch (err) {
      log.warn('[jsonStateFile] sync write of %s failed: %O', filename, err)
    }
  }

  async function flushWrite(): Promise<void> {
    writeTimer = null
    const content = serialize(current)
    // Record before the write so a watcher event racing the rename still matches.
    lastWrittenContent = content
    try {
      const p = filePath()
      await fs.mkdir(path.dirname(p), { recursive: true })
      const tmp = p + '.tmp'
      await fs.writeFile(tmp, content, 'utf-8')
      await fs.rename(tmp, p)
    } catch (err) {
      log.warn('[jsonStateFile] write of %s failed: %O', filename, err)
    }
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
    if (!writeTimer) return
    clearTimeout(writeTimer)
    writeTimer = null
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
