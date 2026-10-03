import { channelStream, defineCapability, method } from '@kernel/rpc/contract'
import type { WorkspaceSettingKey, WorkspaceSettings } from './composed'

export interface SetSettingParams<K extends WorkspaceSettingKey = WorkspaceSettingKey> {
  key: K
  value: WorkspaceSettings[K]
}

/** Workspace settings: read all, edit one key at a time (last write wins),
 *  subscribe to a snapshot and then each change as a partial patch. An invalid
 *  key or value is refused with `rejected`. */
export const settingsCapability = defineCapability('settings', {
  methods: {
    getAll: method<void, WorkspaceSettings>(),
    set: method<SetSettingParams, void>({ mutates: true }),
  },
  streams: {
    subscribe: channelStream<void, WorkspaceSettings>(),
  },
})

declare module '@kernel/rpc/contract' {
  interface CapabilityRegistry {
    settings: typeof settingsCapability
  }
}
