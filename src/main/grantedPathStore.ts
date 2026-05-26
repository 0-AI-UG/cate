// =============================================================================
// grantedPathStore — main-owned persistence for file paths the user has
// explicitly approved via a native dialog (currently the Save-As picker for
// untitled editors).
//
// The list lives in a JSON file under userData and is loaded on first use.
// Crucially, paths can only be ADDED from inside the main process — there is
// no IPC handler that lets a renderer enrol arbitrary paths. The renderer
// never sees this store directly; main grants per-window read+write access
// to each persisted path when a window is created, and the window-scoped
// grant evaporates on window close.
// =============================================================================

import path from 'path'
import { app } from 'electron'
import fs from 'fs/promises'
import log from './logger'

const STORE_FILENAME = 'granted-paths.json'

function storePath(): string {
  return path.join(app.getPath('userData'), STORE_FILENAME)
}

let cache: Set<string> | null = null

async function load(): Promise<Set<string>> {
  if (cache) return cache
  try {
    const raw = await fs.readFile(storePath(), 'utf-8')
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      cache = new Set(parsed.filter((x): x is string => typeof x === 'string'))
      return cache
    }
  } catch {
    // File missing or unreadable — treat as empty.
  }
  cache = new Set()
  return cache
}

async function flush(): Promise<void> {
  if (!cache) return
  try {
    await fs.writeFile(storePath(), JSON.stringify(Array.from(cache)), 'utf-8')
  } catch (err) {
    log.warn('[grantedPathStore] Failed to persist:', err)
  }
}

/** Record `filePath` as a persistently approved location. Idempotent. The
 *  on-disk file is flushed before this promise resolves so an immediate
 *  app quit after a Save-As does not lose the freshly recorded grant. */
export async function recordPersistentGrant(filePath: string): Promise<void> {
  const set = await load()
  if (set.has(filePath)) return
  set.add(filePath)
  await flush()
}

/** Return a snapshot of all currently persisted paths. */
export async function listPersistentGrants(): Promise<string[]> {
  return Array.from(await load())
}

/** Drop a persisted entry — used to prune paths that no longer exist on disk.
 *  Flushed synchronously for the same reason as {@link recordPersistentGrant}. */
export async function removePersistentGrant(filePath: string): Promise<void> {
  const set = await load()
  if (!set.delete(filePath)) return
  await flush()
}
