// Client settings live on the device (the `settings` document of the
// DeviceStore) and apply in every workspace.

import { jsonEqual, type DeviceStore } from '@kernel/state/contract'
import type { SettingsTable, SettingsValues } from '../contract'

export const CLIENT_SETTINGS_DOCUMENT = 'settings'

export type ClientSettingsListener<S extends object = SettingsValues> = (values: S, patch: Partial<S>) => void

/** A device's client settings of a composed table (each shell composes its
 *  own: the shared slices plus its own). */
export interface ClientSettingsStore<S extends object = SettingsValues> {
  /** Read the device document. Until it resolves, values are the defaults. */
  load(): Promise<S>
  getAll(): S
  get<K extends keyof S & string>(key: K): S[K]
  /** Returns false (and changes nothing) for an unknown key or invalid value. */
  set<K extends keyof S & string>(key: K, value: S[K]): boolean
  reset(key: keyof S & string): void
  subscribe(cb: ClientSettingsListener<S>): () => void
  dispose(): void
}

export function createClientSettingsStore<S extends object>(
  device: DeviceStore,
  table: SettingsTable<S>,
): ClientSettingsStore<S> {
  let values: S = { ...table.defaults }
  const listeners = new Set<ClientSettingsListener<S>>()

  const apply = (next: S): void => {
    const patch: Record<string, unknown> = {}
    for (const key of table.keys) {
      if (!jsonEqual(next[key], values[key])) patch[key] = next[key]
    }
    values = next
    if (Object.keys(patch).length === 0) return
    for (const cb of listeners) {
      try { cb(values, patch as Partial<S>) } catch { /* isolate listeners */ }
    }
  }

  const persist = (): void => { void device.set(CLIENT_SETTINGS_DOCUMENT, values).catch(() => {}) }

  const unsubscribeDevice = device.subscribe(CLIENT_SETTINGS_DOCUMENT, (raw) => apply(table.normalize(raw)))

  return {
    async load() {
      apply(table.normalize(await device.get(CLIENT_SETTINGS_DOCUMENT)))
      return values
    },
    getAll: () => ({ ...values }),
    get: (key) => values[key],
    set(key, value) {
      if (!table.validate(key, value)) return false
      apply({ ...values, [key]: value })
      persist()
      return true
    },
    reset(key) {
      apply({ ...values, [key]: table.defaults[key] })
      persist()
    },
    subscribe(cb) {
      listeners.add(cb)
      return () => { listeners.delete(cb) }
    },
    dispose() {
      listeners.clear()
      unsubscribeDevice()
    },
  }
}
