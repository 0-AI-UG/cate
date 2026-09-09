import { create } from 'zustand'
import type { RemoteConnectSpec } from '../../shared/types'
import type { RemoteRuntimeConnection } from '../../shared/runtimeConnection'

interface RemoteConnectionsState {
  connections: RemoteRuntimeConnection[]
  loaded: boolean
  error: string | null
  load: () => Promise<void>
  save: (spec: RemoteConnectSpec, previousId?: string) => Promise<void>
  remove: (runtimeId: string) => Promise<void>
}
let subscribed = false
let revision = 0
let loading: Promise<void> | null = null
export const useRemoteConnectionsStore = create<RemoteConnectionsState>((set, get) => ({
  connections: [], loaded: false, error: null,
  async load() {
    if (get().loaded) return
    if (loading) return loading
    if (!subscribed) {
      subscribed = true
      window.electronAPI.onRemoteConnectionsChanged((connections) => {
        revision++
        set({ connections, loaded: true, error: null })
      })
    }
    const started = revision
    loading = window.electronAPI.remoteConnectionsList().then((connections) => {
      if (started === revision) set({ connections, loaded: true, error: null })
    }).catch((err) => { if (started === revision) set({ error: err instanceof Error ? err.message : String(err) }) }).finally(() => { loading = null })
    return loading
  },
  async save(spec, previousId) {
    const started = revision
    const connections = await window.electronAPI.remoteConnectionsSave(spec, previousId)
    if (started === revision) { revision++; set({ connections, loaded: true, error: null }) }
  },
  async remove(runtimeId) {
    const started = revision
    const connections = await window.electronAPI.remoteConnectionsRemove(runtimeId)
    if (started === revision) { revision++; set({ connections, loaded: true, error: null }) }
  },
}))
