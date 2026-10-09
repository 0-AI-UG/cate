// A session's own state file, `<data>/sessions/<panelId>.json`: read once,
// written debounced and atomic, set aside when the panel is removed (so undo
// brings it back) and deleted when the panel is replaced.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Logger } from '@kernel/log/contract'
import { readJsonFile, writeJsonAtomic, writeJsonAtomicSync } from '@kernel/state/node'
import type { Json } from '@workspace/document/contract'
import type { SessionStore } from './PanelSession'

export interface SessionFileStore extends SessionStore {
  /** Writes a pending value synchronously (shutdown). */
  flushSync(): void
  /** Stops writing, waits for a write in flight, writes what is pending and
   *  moves the file to `to` (panel removed), or deletes it when `to` is null
   *  (panel replaced by another type). */
  retire(to: string | null): Promise<void>
}

const MISSING = Symbol('missing')

export function createSessionFileStore(file: string, log: Logger, debounceMs = 250): SessionFileStore {
  let value: Json | undefined
  let loaded = false
  let dirty = false
  let removed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let writing: Promise<void> | null = null

  const load = () => {
    if (loaded) return
    loaded = true
    const read = readJsonFile<Json | typeof MISSING>(file, MISSING)
    value = read === MISSING ? undefined : read
  }

  const writeLoop = async () => {
    while (dirty && !removed) {
      dirty = false
      await writeJsonAtomic(file, value ?? null)
    }
  }

  const flush = (): Promise<void> => {
    if (timer) { clearTimeout(timer); timer = null }
    writing ??= writeLoop()
      .catch((err) => { dirty = true; log.warn('writing %s failed: %s', file, (err as Error).message) })
      .finally(() => { writing = null })
    return writing
  }

  return {
    read() {
      load()
      return value
    },
    write(next) {
      if (removed) return
      loaded = true
      value = next
      dirty = true
      timer ??= setTimeout(() => { timer = null; void flush() }, debounceMs)
    },
    flush,
    flushSync() {
      if (timer) { clearTimeout(timer); timer = null }
      if (!dirty || removed) return
      dirty = false
      try { writeJsonAtomicSync(file, value ?? null) } catch (err) { log.warn('writing %s failed: %s', file, (err as Error).message) }
    },
    async retire(to) {
      if (removed) return
      removed = true
      if (timer) { clearTimeout(timer); timer = null }
      await writing
      try {
        if (to === null) {
          await fs.rm(file, { force: true })
          return
        }
        await fs.mkdir(path.dirname(to), { recursive: true })
        if (dirty) await writeJsonAtomic(to, value ?? null)
        else await fs.rename(file, to)
        await fs.rm(file, { force: true })
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('retiring %s failed: %s', file, (err as Error).message)
      } finally {
        dirty = false
      }
    },
  }
}
