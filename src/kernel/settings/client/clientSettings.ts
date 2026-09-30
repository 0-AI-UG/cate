// Client settings live on the device (the `settings` document of the
// DeviceStore) and apply in every workspace.

import { jsonEqual, type DeviceStore } from '@kernel/state/contract'
import { clientSettingsTable, type ClientSettingKey, type ClientSettings, type SettingsTable } from '../contract'

export const CLIENT_SETTINGS_DOCUMENT = 'settings'

export type ClientSettingsListener = (values: ClientSettings, patch: Partial<ClientSettings>) => void

export interface ClientSettingsStore {
  /** Read the device document. Until it resolves, values are the defaults. */
  load(): Promise<ClientSettings>
  getAll(): ClientSettings
  get<K extends ClientSettingKey>(key: K): ClientSettings[K]
  /** Returns false (and changes nothing) for an unknown key or invalid value. */
  set<K extends ClientSettingKey>(key: K, value: ClientSettings[K]): boolean
  reset(key: ClientSettingKey): void
  subscribe(cb: ClientSettingsListener): () => void
  dispose(): void
}

export function createClientSettingsStore(
  device: DeviceStore,
  table: SettingsTable<ClientSettings> = clientSettingsTable,
): ClientSettingsStore {
  let values: ClientSettings = { ...table.defaults }
  const listeners = new Set<ClientSettingsListener>()

  const apply = (next: ClientSettings): void => {
    const patch: Record<string, unknown> = {}
    for (const key of table.keys) {
      if (!jsonEqual(next[key], values[key])) patch[key] = next[key]
    }
    values = next
    if (Object.keys(patch).length === 0) return
    for (const cb of listeners) {
      try { cb(values, patch as Partial<ClientSettings>) } catch { /* isolate listeners */ }
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
