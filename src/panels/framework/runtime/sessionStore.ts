// A session's own state file, `<data>/sessions/<panelId>.json`, written
// through kernel/state (read once, debounced atomic writes, corrupt-file
// quarantine). Set aside when the panel is removed (so undo brings it back)
// and deleted when the panel is replaced. Nobody subscribes, so the file is
// not watched: the session holds its state in memory and has no way to take a
// hand edit while it runs, and one watcher per panel would be costly.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Logger } from '@kernel/log/contract'
import { createJsonStateFile } from '@kernel/state/node'
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

export function createSessionFileStore(file: string, log: Logger, debounceMs = 250): SessionFileStore {
  // `null` stands for "no state yet" (a missing file).
  const state = createJsonStateFile<Json>({
    file,
    defaults: null,
    normalize: (parsed) => parsed as Json,
    debounceMs,
  })
  let removed = false

  return {
    read() {
      return state.get() ?? undefined
    },
    write(next) {
      if (!removed) state.set(next)
    },
    flush: () => state.flush(),
    flushSync() {
      if (!removed) state.flushSync()
    },
    async retire(to) {
      if (removed) return
      removed = true
      // Lands the pending value at `file`; dispose retries it synchronously
      // when that write failed.
      await state.flush()
      state.dispose()
      try {
        if (to === null) {
          await fs.rm(file, { force: true })
          return
        }
        await fs.mkdir(path.dirname(to), { recursive: true })
        await fs.rename(file, to)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('retiring %s failed: %s', file, (err as Error).message)
      }
    },
  }
}
