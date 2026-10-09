import { channelStream, defineCapability, method } from '@kernel/rpc/contract'

/** A composed table's values on the wire: the kernel knows no keys. */
export type SettingsValues = Record<string, unknown>

export interface SetSettingParams {
  key: string
  value: unknown
}

/** Workspace settings: read all, edit one key at a time (last write wins),
 *  subscribe to a snapshot and then each change as a partial patch. An invalid
 *  key or value is refused with `rejected`. */
export const settingsCapability = defineCapability('settings', {
  methods: {
    getAll: method<void, SettingsValues>(),
    set: method<SetSettingParams, void>({ mutates: true }),
  },
  streams: {
    subscribe: channelStream<void, SettingsValues>(),
  },
})

declare module '@kernel/rpc/contract' {
  interface CapabilityRegistry {
    settings: typeof settingsCapability
  }
}
