// Each connected workspace's settings for the app: one mirror per
// connection, read by relations and availability and set through it.

import { createWorkspaceSettingsMirror, type WorkspaceSettingsMirror } from '@kernel/settings/client'
import { eachConnection } from '@client/connections'
import { workspaceSettingsTable, type WorkspaceSettings } from '@panels/settings'
import type { MobileClient } from './boot'

export interface MobileWorkspaceSettings {
  /** The workspace's mirror; null while not connected. */
  of(workspaceId: string): WorkspaceSettingsMirror<WorkspaceSettings> | null
  subscribe(listener: () => void): () => void
}

export function createMobileWorkspaceSettings(client: Pick<MobileClient, 'connections'>): MobileWorkspaceSettings {
  const mirrors = new Map<string, WorkspaceSettingsMirror<WorkspaceSettings>>()
  const listeners = new Set<() => void>()
  const changed = () => {
    for (const listener of [...listeners]) listener()
  }

  eachConnection(client.connections, ({ workspaceId, runtime }) => {
    const mirror = createWorkspaceSettingsMirror(runtime.settings, workspaceSettingsTable)
    mirrors.set(workspaceId, mirror)
    const off = mirror.subscribe(changed)
    return () => {
      off()
      mirror.dispose()
      if (mirrors.get(workspaceId) === mirror) mirrors.delete(workspaceId)
      changed()
    }
  })

  return {
    of: (workspaceId) => mirrors.get(workspaceId) ?? null,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
