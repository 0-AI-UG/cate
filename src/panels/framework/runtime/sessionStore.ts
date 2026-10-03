// A session's own state file, `<data>/sessions/<panelId>.json`: read once,
// written debounced and atomic, removed with the panel.

import type { Logger } from '@kernel/log/contract'
import { readJsonFile, removeFile, writeJsonAtomic, writeJsonAtomicSync } from '@kernel/state/node'
import type { Json } from '@workspace/document/contract'
import type { SessionStore } from './PanelSession'

export interface SessionFileStore extends SessionStore {
  /** Writes a pending value synchronously (shutdown). */
  flushSync(): void
  /** Drops pending writes and deletes the file (panel removed). */
  remove(): void
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
    // A removal while the write ran: the file must not survive it.
    if (removed) removeFile(file)
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
    remove() {
      removed = true
      dirty = false
      if (timer) { clearTimeout(timer); timer = null }
      removeFile(file)
    },
  }
}
