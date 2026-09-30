// The settings the canvas reads: client settings (zoom speed, grid, snapping,
// wallpaper, ...) and, per workspace, the shared workspace settings. The
// client shell installs its stores; until then defaults apply.

import { useCallback, useSyncExternalStore } from 'react'
import {
  clientSettingsTable,
  workspaceSettingsTable,
  type ClientSettingKey,
  type ClientSettings,
  type WorkspaceSettingKey,
  type WorkspaceSettings,
} from '@kernel/settings/contract'
import type { ClientSettingsStore, WorkspaceSettingsMirror } from '@kernel/settings/client'

type WorkspaceSource = Pick<WorkspaceSettingsMirror, 'get' | 'subscribe'>

/** The kernel settings stores, as the shell holds them. */
export interface CanvasSettingsSources {
  client: Pick<ClientSettingsStore, 'get' | 'subscribe'> & Partial<Pick<ClientSettingsStore, 'set'>>
  workspace?(workspaceId: string): WorkspaceSource | null
}

let sources: CanvasSettingsSources | null = null
let stopClient: () => void = () => {}
const listeners = new Set<() => void>()

const emit = () => {
  for (const listener of [...listeners]) listener()
}

export function installCanvasSettings(next: CanvasSettingsSources | null): void {
  stopClient()
  sources = next
  stopClient = next ? next.client.subscribe(emit) : () => {}
  emit()
}

export function canvasSetting<K extends ClientSettingKey>(key: K): ClientSettings[K] {
  return sources ? sources.client.get(key) : clientSettingsTable.defaults[key]
}

export function setCanvasSetting<K extends ClientSettingKey>(key: K, value: ClientSettings[K]): void {
  sources?.client.set?.(key, value)
}

function workspaceSetting<K extends WorkspaceSettingKey>(workspaceId: string, key: K): WorkspaceSettings[K] {
  const source = sources?.workspace?.(workspaceId)
  return source ? source.get(key) : workspaceSettingsTable.defaults[key]
}

/** Fires on any client settings change or a new install. */
export function subscribeCanvasSettings(listener: () => void): () => void {
  return subscribeSources(listener)
}

/** The installed workspace settings of a workspace, null without one. */
export function workspaceSettingsSource(workspaceId: string): WorkspaceSource | null {
  return sources?.workspace?.(workspaceId) ?? null
}

function subscribeSources(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useCanvasSetting<K extends ClientSettingKey>(key: K): ClientSettings[K] {
  return useSyncExternalStore(subscribeSources, () => canvasSetting(key))
}

export function useWorkspaceSetting<K extends WorkspaceSettingKey>(workspaceId: string, key: K): WorkspaceSettings[K] {
  const subscribe = useCallback((listener: () => void) => {
    let stopValues: () => void = () => {}
    const bind = () => {
      stopValues()
      const source = sources?.workspace?.(workspaceId)
      stopValues = source ? source.subscribe(listener) : () => {}
    }
    bind()
    // A new install may bring a different mirror.
    const stopInstall = subscribeSources(() => { bind(); listener() })
    return () => { stopInstall(); stopValues() }
  }, [workspaceId])
  return useSyncExternalStore(subscribe, () => workspaceSetting(workspaceId, key))
}
