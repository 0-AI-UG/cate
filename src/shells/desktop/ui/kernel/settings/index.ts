// React access to settings for every settings page and view (section 8).
// Client settings come from the store the shell installs; workspace settings
// from a mirror of each open workspace's `settings` capability, made on first
// use and dropped when the workspace's runtime goes.

import { useSyncExternalStore } from 'react'
import { subscribeRuntimes, tryRuntimeFor } from '@kernel/rpc/client'
import type { RuntimeProxy } from '@kernel/rpc/contract'
import {
  clientSettingsTable,
  workspaceSettingsTable,
  type ClientSettingKey,
  type ClientSettings,
  type WorkspaceSettingKey,
  type WorkspaceSettings,
} from '@kernel/settings/contract'
import { createWorkspaceSettingsMirror, type ClientSettingsStore, type WorkspaceSettingsMirror } from '@kernel/settings/client'

// --- Client settings -------------------------------------------------------

let clientStore: ClientSettingsStore | null = null
const clientListeners = new Set<() => void>()
let unsubscribeClient: () => void = () => {}

const notifyClient = (): void => { for (const l of [...clientListeners]) l() }

/** The shell installs the device's client settings store once at start. */
export function installClientSettings(store: ClientSettingsStore | null): void {
  unsubscribeClient()
  clientStore = store
  unsubscribeClient = store ? store.subscribe(notifyClient) : () => {}
  notifyClient()
}

export function clientSettings(): ClientSettingsStore | null {
  return clientStore
}

const subscribeClient = (listener: () => void): (() => void) => {
  clientListeners.add(listener)
  return () => { clientListeners.delete(listener) }
}

export function getClientSetting<K extends ClientSettingKey>(key: K): ClientSettings[K] {
  return clientStore ? clientStore.get(key) : clientSettingsTable.defaults[key]
}

/** Returns false for an invalid value or when no store is installed. */
export function setClientSetting<K extends ClientSettingKey>(key: K, value: ClientSettings[K]): boolean {
  return clientStore?.set(key, value) ?? false
}

export function useClientSetting<K extends ClientSettingKey>(key: K): ClientSettings[K] {
  return useSyncExternalStore(subscribeClient, () => getClientSetting(key))
}

// --- Workspace settings ----------------------------------------------------

interface MirrorEntry {
  runtime: RuntimeProxy
  mirror: WorkspaceSettingsMirror
  values: WorkspaceSettings
}

const mirrors = new Map<string, MirrorEntry>()
const workspaceListeners = new Map<string, Set<() => void>>()

const notifyWorkspace = (workspaceId: string): void => {
  for (const l of [...(workspaceListeners.get(workspaceId) ?? [])]) l()
}

function drop(workspaceId: string): void {
  const entry = mirrors.get(workspaceId)
  if (!entry) return
  mirrors.delete(workspaceId)
  entry.mirror.dispose()
  notifyWorkspace(workspaceId)
}

subscribeRuntimes(() => {
  for (const [workspaceId, entry] of [...mirrors]) {
    if (tryRuntimeFor(workspaceId) !== entry.runtime) drop(workspaceId)
  }
  // Workspaces that just opened: let their subscribers make a mirror.
  for (const workspaceId of workspaceListeners.keys()) {
    if (!mirrors.has(workspaceId) && tryRuntimeFor(workspaceId)) notifyWorkspace(workspaceId)
  }
})

/** The settings mirror of an open workspace, or null when it is not open. */
export function workspaceSettingsFor(workspaceId: string): WorkspaceSettingsMirror | null {
  const runtime = tryRuntimeFor(workspaceId)
  if (!runtime) return null
  const existing = mirrors.get(workspaceId)
  if (existing?.runtime === runtime) return existing.mirror
  if (existing) drop(workspaceId)
  const mirror = createWorkspaceSettingsMirror(runtime.settings)
  const entry: MirrorEntry = { runtime, mirror, values: mirror.getAll() }
  mirror.subscribe((values) => {
    entry.values = values
    notifyWorkspace(workspaceId)
  })
  mirrors.set(workspaceId, entry)
  return mirror
}

function subscribeWorkspace(workspaceId: string, listener: () => void): () => void {
  let set = workspaceListeners.get(workspaceId)
  if (!set) workspaceListeners.set(workspaceId, (set = new Set()))
  set.add(listener)
  return () => {
    set.delete(listener)
    if (set.size === 0) workspaceListeners.delete(workspaceId)
  }
}

const noop = () => () => {}

/** All of a workspace's settings; the defaults while it is not open. */
export function useWorkspaceSettings(workspaceId: string | null | undefined): WorkspaceSettings {
  return useSyncExternalStore(
    workspaceId ? (l) => subscribeWorkspace(workspaceId, l) : noop,
    () => {
      if (!workspaceId || !workspaceSettingsFor(workspaceId)) return workspaceSettingsTable.defaults
      return mirrors.get(workspaceId)!.values
    },
  )
}

export function useWorkspaceSetting<K extends WorkspaceSettingKey>(
  workspaceId: string | null | undefined,
  key: K,
): WorkspaceSettings[K] {
  return useWorkspaceSettings(workspaceId)[key]
}

/** Edits one workspace setting for everyone in the workspace. Rejects when the
 *  workspace is not open, the value is invalid or the runtime refuses it. */
export async function setWorkspaceSetting<K extends WorkspaceSettingKey>(
  workspaceId: string,
  key: K,
  value: WorkspaceSettings[K],
): Promise<void> {
  const mirror = workspaceSettingsFor(workspaceId)
  if (!mirror) throw new Error(`Workspace ${workspaceId} is not open`)
  await mirror.set(key, value)
}
