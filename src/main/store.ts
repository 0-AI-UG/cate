// =============================================================================
// Settings store and session persistence — backed by electron-store
// electron-store v10 is ESM-only, so we use dynamic import()
// =============================================================================

import { ipcMain, app } from 'electron'
import log from './logger'
import fs from 'fs/promises'
import fsSync from 'fs'
import path from 'path'
import {
  SETTINGS_GET,
  SETTINGS_SET,
  SETTINGS_GET_ALL,
  SETTINGS_RESET,
  SESSION_SAVE,
  SESSION_LOAD,
  SESSION_CLEAR,
  APP_GET_PATH,
  RECENT_PROJECTS_GET,
  RECENT_PROJECTS_ADD,
  LAYOUT_SAVE,
  LAYOUT_LIST,
  LAYOUT_LOAD,
  LAYOUT_DELETE,
} from '../shared/ipc-channels'
import { DEFAULT_SETTINGS } from '../shared/types'
import type { AppSettings, SessionSnapshot } from '../shared/types'

// Lazy-loaded store instance (ESM dynamic import)
let storeInstance: any = null

async function getStore(): Promise<any> {
  if (storeInstance) return storeInstance
  const { default: Store } = await import('electron-store')
  storeInstance = new Store<AppSettings>({ defaults: DEFAULT_SETTINGS })
  return storeInstance
}

function getSessionPath(): string {
  return path.join(app.getPath('userData'), 'Sessions', 'session.json')
}

// ---------------------------------------------------------------------------
// Write serialization — ensures only one session write runs at a time
// ---------------------------------------------------------------------------
let writeQueue: Promise<void> = Promise.resolve()
function serialized(fn: () => Promise<void>): Promise<void> {
  writeQueue = writeQueue.then(fn, fn)
  return writeQueue
}

// ---------------------------------------------------------------------------
// Last-saved session cache (for sync fallback on quit)
// ---------------------------------------------------------------------------
let lastSavedSessionJson: string | null = null

export function getLastSavedSession(): string | null {
  return lastSavedSessionJson
}

// ---------------------------------------------------------------------------
// Atomic write: write to .tmp, rotate .bak, rename .tmp → target
// ---------------------------------------------------------------------------
async function atomicWriteSession(sessionPath: string, json: string): Promise<void> {
  const dir = path.dirname(sessionPath)
  const tmpPath = sessionPath + '.tmp'
  const bakPath = sessionPath + '.bak'

  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(tmpPath, json, 'utf-8')
  await fs.rename(sessionPath, bakPath).catch(() => {}) // OK if no previous file
  await fs.rename(tmpPath, sessionPath)
}

/** Synchronous variant — only used as last-resort in will-quit */
export function saveSessionSync(json: string | null): void {
  if (!json) return
  const sessionPath = getSessionPath()
  const dir = path.dirname(sessionPath)
  const tmpPath = sessionPath + '.tmp'
  const bakPath = sessionPath + '.bak'

  try {
    fsSync.mkdirSync(dir, { recursive: true })
    fsSync.writeFileSync(tmpPath, json, 'utf-8')
    try { fsSync.renameSync(sessionPath, bakPath) } catch { /* OK */ }
    fsSync.renameSync(tmpPath, sessionPath)
  } catch (err) {
    log.warn('Sync session save failed: %O', err)
  }
}

// ---------------------------------------------------------------------------
// Session validation
// ---------------------------------------------------------------------------
function isValidSession(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false
  const obj = data as Record<string, unknown>
  if (obj.version === 2 && Array.isArray(obj.workspaces)) return true
  if (Array.isArray(obj.nodes)) return true // legacy format
  return false
}

/** Try to read and parse a session file, returning null on any failure */
async function tryLoadSession(filePath: string): Promise<unknown | null> {
  try {
    const data = await fs.readFile(filePath, 'utf-8')
    const parsed = JSON.parse(data)
    if (isValidSession(parsed)) return parsed
    log.warn('Session file failed validation: %s', filePath)
    return null
  } catch {
    return null
  }
}

export function registerHandlers(): void {
  // Settings
  ipcMain.handle(SETTINGS_GET, async (_event, key: keyof AppSettings) => {
    const store = await getStore()
    return store.get(key)
  })

  ipcMain.handle(
    SETTINGS_SET,
    async (_event, key: keyof AppSettings, value: unknown) => {
      const store = await getStore()
      store.set(key, value as never)
    },
  )

  ipcMain.handle(SETTINGS_GET_ALL, async () => {
    const store = await getStore()
    return store.store
  })

  ipcMain.handle(SETTINGS_RESET, async (_event, key?: keyof AppSettings) => {
    const store = await getStore()
    if (key) {
      store.reset(key)
    } else {
      store.clear()
    }
  })

  // Session persistence (atomic writes with backup rotation)
  ipcMain.handle(SESSION_SAVE, async (_event, snapshot: SessionSnapshot) => {
    const json = JSON.stringify(snapshot, null, 2)
    lastSavedSessionJson = json
    await serialized(async () => {
      const sessionPath = getSessionPath()
      await atomicWriteSession(sessionPath, json)
      log.debug('Session saved to %s', sessionPath)
    })
  })

  ipcMain.handle(SESSION_CLEAR, async () => {
    const sessionPath = getSessionPath()
    try {
      await fs.unlink(sessionPath)
    } catch {
      // file may not exist
    }
  })

  ipcMain.handle(SESSION_LOAD, async (): Promise<SessionSnapshot | null> => {
    const sessionPath = getSessionPath()
    const tmpPath = sessionPath + '.tmp'
    const bakPath = sessionPath + '.bak'

    // Fallback chain: session.json → .tmp (crash mid-rename) → .bak (last known good)
    const candidates = [
      { path: sessionPath, label: 'session.json' },
      { path: tmpPath, label: 'session.json.tmp' },
      { path: bakPath, label: 'session.json.bak' },
    ]

    for (const candidate of candidates) {
      const result = await tryLoadSession(candidate.path)
      if (result) {
        if (candidate.path !== sessionPath) {
          log.warn('Recovered session from %s', candidate.label)
        } else {
          log.debug('Session loaded from %s', sessionPath)
        }
        return result as SessionSnapshot
      }
    }

    log.debug('No valid session file found')
    return null
  })

  // App paths
  ipcMain.handle(APP_GET_PATH, async (_event, name: string) => {
    return app.getPath(name as Parameters<typeof app.getPath>[0])
  })

  // Recent Projects
  ipcMain.handle(RECENT_PROJECTS_GET, async () => {
    const store = await getStore()
    return store.get('recentProjects', []) as string[]
  })

  ipcMain.handle(RECENT_PROJECTS_ADD, async (_event, projectPath: string) => {
    const store = await getStore()
    const existing: string[] = store.get('recentProjects', []) as string[]
    const filtered = existing.filter((p) => p !== projectPath)
    const updated = [projectPath, ...filtered].slice(0, 10)
    store.set('recentProjects', updated)
  })

  // Layouts
  ipcMain.handle(LAYOUT_SAVE, async (_event, name: string, layout: unknown) => {
    const store = await getStore()
    const layouts = (store.get('layouts') as Record<string, unknown>) || {}
    layouts[name] = layout
    store.set('layouts', layouts)
  })

  ipcMain.handle(LAYOUT_LIST, async () => {
    const store = await getStore()
    const layouts = (store.get('layouts') as Record<string, unknown>) || {}
    return Object.keys(layouts)
  })

  ipcMain.handle(LAYOUT_LOAD, async (_event, name: string) => {
    const store = await getStore()
    const layouts = (store.get('layouts') as Record<string, unknown>) || {}
    return layouts[name] || null
  })

  ipcMain.handle(LAYOUT_DELETE, async (_event, name: string) => {
    const store = await getStore()
    const layouts = (store.get('layouts') as Record<string, unknown>) || {}
    delete layouts[name]
    store.set('layouts', layouts)
  })

}
