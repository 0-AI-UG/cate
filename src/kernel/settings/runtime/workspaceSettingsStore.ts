// Workspace settings on the runtime: `<data>/settings.json`, hand-editable, one
// writer (this daemon). Edits arrive one key at a time; last write wins.

import fs from 'node:fs'
import path from 'node:path'
import { RpcError, type ChannelEvent } from '@kernel/rpc/contract'
import { jsonEqual } from '@kernel/state/contract'
import { createJsonStateFile } from '@kernel/state/node'
import {
  workspaceSettingsTable,
  type SetSettingParams,
  type SettingsTable,
  type WorkspaceSettingKey,
  type WorkspaceSettings,
} from '../contract'

export const WORKSPACE_SETTINGS_FILE = 'settings.json'

export type SettingsPatch = Partial<WorkspaceSettings>

export interface WorkspaceSettingsStore {
  readonly path: string
  getAll(): WorkspaceSettings
  get<K extends WorkspaceSettingKey>(key: K): WorkspaceSettings[K]
  /** Throws `rejected` for an unknown key or an invalid value. */
  set<K extends WorkspaceSettingKey>(key: K, value: WorkspaceSettings[K]): void
  /** Every change, local or a hand edit of the file, as the keys that moved. */
  subscribe(cb: (values: WorkspaceSettings, patch: SettingsPatch) => void): () => void
  flushDurable(): Promise<void>
  flushSync(): void
  dispose(): void
}

export function createWorkspaceSettingsStore(options: {
  dataDir: string
  table?: SettingsTable<WorkspaceSettings>
}): WorkspaceSettingsStore {
  const table = options.table ?? workspaceSettingsTable
  const file = createJsonStateFile<WorkspaceSettings>({
    file: path.join(options.dataDir, WORKSPACE_SETTINGS_FILE),
    defaults: { ...table.defaults },
    normalize: (parsed) => table.normalize(parsed),
  })
  const existed = fs.existsSync(file.path)
  file.load()
  if (!existed) {
    // Seed defaults so the file exists for hand editing.
    file.set({ ...file.get() })
    file.flushSync()
  }

  const listeners = new Set<(values: WorkspaceSettings, patch: SettingsPatch) => void>()
  let last = file.get()
  let unsubscribeFile: (() => void) | null = null

  const onFileChange = (next: WorkspaceSettings): void => {
    const patch: Record<string, unknown> = {}
    for (const key of table.keys) {
      if (!jsonEqual(next[key], last[key])) patch[key] = next[key]
    }
    last = next
    if (Object.keys(patch).length === 0) return
    for (const cb of listeners) {
      try { cb(next, patch as SettingsPatch) } catch { /* isolate listeners */ }
    }
  }

  return {
    path: file.path,
    getAll: () => ({ ...file.get() }),
    get: (key) => file.get()[key],
    set(key, value) {
      if (!table.has(key)) throw new RpcError('rejected', `Unknown setting "${key}"`)
      if (!table.validate(key, value)) throw new RpcError('rejected', `Invalid value for setting "${key}"`)
      file.update((current) => ({ ...current, [key]: value }))
    },
    subscribe(cb) {
      listeners.add(cb)
      if (!unsubscribeFile) {
        last = file.get()
        unsubscribeFile = file.subscribe(onFileChange)
      }
      return () => {
        listeners.delete(cb)
        if (listeners.size === 0 && unsubscribeFile) {
          unsubscribeFile()
          unsubscribeFile = null
        }
      }
    },
    flushDurable: () => file.flushDurable(),
    flushSync: () => file.flushSync(),
    dispose: () => {
      listeners.clear()
      unsubscribeFile = null
      file.dispose()
    },
  }
}

/** The `settings` capability's handlers over a store. `subscribe` emits the
 *  snapshot, then one change per edit. */
export interface SettingsHandlers {
  getAll(): WorkspaceSettings
  set(params: SetSettingParams): void
  subscribe(emit: (event: ChannelEvent<WorkspaceSettings, SettingsPatch>) => void): () => void
}

export function createSettingsHandlers(store: WorkspaceSettingsStore): SettingsHandlers {
  return {
    getAll: () => store.getAll(),
    set: ({ key, value }) => store.set(key, value),
    subscribe(emit) {
      let rev = 0
      emit({ kind: 'snapshot', rev, snapshot: store.getAll() })
      return store.subscribe((_values, patch) => emit({ kind: 'change', rev: ++rev, change: patch }))
    },
  }
}
