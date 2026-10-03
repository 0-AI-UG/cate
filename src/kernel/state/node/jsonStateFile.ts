// A hand-editable JSON file as the source of truth: synchronous load, an
// authoritative in-memory copy always normalized over defaults, debounced
// atomic writes, an external-edit watcher and corrupt-file quarantine.
//
// `normalize` is the single authority for the file's shape: raw parsed JSON in,
// a complete validated value out. It must not throw; a malformed hand edit
// degrades to defaults.

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { watch } from 'chokidar'
import { createLogger } from '../../log/contract'
import { createJsonStateStore, type JsonStateChangeOrigin } from '../contract/store'
import { writeJsonAtomic, writeJsonAtomicSync } from './atomicFile'
import { quarantineCorruptFile } from './quarantine'

const log = createLogger('state')

export interface JsonStateFileOptions<T> {
  /** Absolute path of the backing file. */
  file: string
  defaults: T
  normalize: (parsed: unknown, defaults: T) => T
  /** File mode, e.g. 0o600 for secrets (the directory is then 0o700). */
  mode?: number
  debounceMs?: number
}

export interface JsonStateFile<T> {
  /** Synchronous load from disk (idempotent). */
  load(): T
  /** Current in-memory value (always complete). */
  get(): T
  /** Replace the value; persisted by a debounced atomic write. */
  set(next: T): void
  update(fn: (current: T) => T): void
  /** Local changes and external edits. The file is watched while at least one
   *  subscriber exists. */
  subscribe(cb: (next: T, origin: JsonStateChangeOrigin) => void): () => void
  readonly path: string
  /** Make sure the file exists on disk (writes defaults when absent). */
  ensureFile(): Promise<string>
  /** Wait for pending writes to settle. */
  flush(): Promise<void>
  /** Wait until the latest value is on disk; rejects when the write failed. */
  flushDurable(): Promise<void>
  /** Write a pending value synchronously (on quit). */
  flushSync(): void
  /** Flush synchronously, drop subscribers and stop watching. */
  dispose(): void
}

export function createJsonStateFile<T>(options: JsonStateFileOptions<T>): JsonStateFile<T> {
  const { file, defaults, normalize, mode } = options
  const name = path.basename(file)
  const writeOptions = mode !== undefined ? { mode } : {}

  const state = createJsonStateStore<T>({
    defaults,
    normalize,
    debounceMs: options.debounceMs,
    backend: {
      readSync: () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null),
      read: async () => {
        try { return await fsp.readFile(file, 'utf-8') } catch { return null }
      },
      write: async (value) => { await writeJsonAtomic(file, value, writeOptions) },
      writeSync: (value) => { writeJsonAtomicSync(file, value, writeOptions) },
      watch: (onChange) => {
        const watcher = watch(file, { ignoreInitial: true })
        watcher.on('change', onChange)
        watcher.on('add', onChange)
        watcher.on('error', (error) => log.warn('watcher error for %s: %O', name, error))
        return () => { void watcher.close() }
      },
    },
    onInvalid: (phase) => {
      if (phase === 'external') {
        log.warn('external edit of %s is not valid JSON; keeping current', name)
        return
      }
      const backup = quarantineCorruptFile(file)
      if (backup) log.error('%s is corrupt; backed up to %s and using defaults', name, backup)
      else log.warn('corrupt backup for %s failed', name)
    },
    onError: (operation, error) => log.warn('%s of %s failed: %O', operation, name, error),
  })

  const load = (): T => state.loadSync()

  return {
    load,
    get: () => { load(); return state.get() },
    set: (next) => { load(); state.set(next) },
    update: (fn) => { load(); state.update(fn) },
    subscribe: (cb) => { load(); return state.subscribe(cb) },
    path: file,
    async ensureFile() {
      load()
      try {
        await fsp.access(file)
      } catch {
        await state.flush(true)
      }
      return file
    },
    flush: () => state.flush(),
    flushDurable: () => state.flushDurable(),
    flushSync: () => state.flushSync(),
    dispose: () => state.dispose(),
  }
}
