// Workspace settings on the runtime: `<data>/settings.json`, hand-editable, one
// writer (this daemon). Edits arrive one key at a time; last write wins.

import fs from 'node:fs'
import path from 'node:path'
import { RpcError, type ChannelEvent } from '@kernel/rpc/contract'
import { jsonEqual } from '@kernel/state/contract'
import { createJsonStateFile } from '@kernel/state/node'
import { type SetSettingParams, type SettingsTable, type SettingsValues } from '../contract'

export const WORKSPACE_SETTINGS_FILE = 'settings.json'

/** The workspace settings store of a composed table (the composition is the
 *  caller's: the kernel knows no slice). */
export interface WorkspaceSettingsStore<S extends object = SettingsValues> {
  readonly path: string
  getAll(): S
  get<K extends keyof S & string>(key: K): S[K]
  /** Throws `rejected` for an unknown key or an invalid value. */
  set<K extends keyof S & string>(key: K, value: S[K]): void
  /** Every change, local or a hand edit of the file, as the keys that moved. */
  subscribe(cb: (values: S, patch: Partial<S>) => void): () => void
  flushDurable(): Promise<void>
  flushSync(): void
  dispose(): void
}

export function createWorkspaceSettingsStore<S extends object>(options: {
  dataDir: string
  table: SettingsTable<S>
}): WorkspaceSettingsStore<S> {
  const table = options.table
  const file = createJsonStateFile<S>({
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

  const listeners = new Set<(values: S, patch: Partial<S>) => void>()
  let last = file.get()
  let unsubscribeFile: (() => void) | null = null

  const onFileChange = (next: S): void => {
    const patch: Record<string, unknown> = {}
    for (const key of table.keys) {
      if (!jsonEqual(next[key], last[key])) patch[key] = next[key]
    }
    last = next
    if (Object.keys(patch).length === 0) return
    for (const cb of listeners) {
      try { cb(next, patch as Partial<S>) } catch { /* isolate listeners */ }
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
  getAll(): SettingsValues
  set(params: SetSettingParams): void
  subscribe(emit: (event: ChannelEvent<SettingsValues, Partial<SettingsValues>>) => void): () => void
}

export function createSettingsHandlers<S extends object>(store: WorkspaceSettingsStore<S>): SettingsHandlers {
  return {
    getAll: () => store.getAll() as SettingsValues,
    set: ({ key, value }) => store.set(key as keyof S & string, value as S[keyof S & string]),
    subscribe(emit) {
      let rev = 0
      emit({ kind: 'snapshot', rev, snapshot: store.getAll() as SettingsValues })
      return store.subscribe((_values, patch) => emit({ kind: 'change', rev: ++rev, change: patch as Partial<SettingsValues> }))
    },
  }
}
