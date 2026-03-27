// =============================================================================
// Settings store and session persistence — backed by electron-store
// electron-store v10 is ESM-only, so we use dynamic import()
// =============================================================================

import { ipcMain, app } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import {
  SETTINGS_GET,
  SETTINGS_SET,
  SETTINGS_GET_ALL,
  SETTINGS_RESET,
  SESSION_SAVE,
  SESSION_LOAD,
  APP_GET_PATH,
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

  // Session persistence
  ipcMain.handle(SESSION_SAVE, async (_event, snapshot: SessionSnapshot) => {
    const sessionPath = getSessionPath()
    const dir = path.dirname(sessionPath)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(sessionPath, JSON.stringify(snapshot, null, 2), 'utf-8')
  })

  ipcMain.handle(SESSION_LOAD, async (): Promise<SessionSnapshot | null> => {
    const sessionPath = getSessionPath()
    try {
      const data = await fs.readFile(sessionPath, 'utf-8')
      return JSON.parse(data) as SessionSnapshot
    } catch {
      return null
    }
  })

  // App paths
  ipcMain.handle(APP_GET_PATH, async (_event, name: string) => {
    return app.getPath(name as Parameters<typeof app.getPath>[0])
  })
}
