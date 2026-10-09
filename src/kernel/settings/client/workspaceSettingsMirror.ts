// A client's mirror of one workspace's settings. Edits apply optimistically and
// stay overlaid until the runtime answers; a refused edit falls back to the
// runtime's value. The runtime emits the change before it answers `set`, so by
// the time an edit resolves the mirrored value already holds it.

import { RpcError, applyShallowPatch, reduceChannel, type ChannelEvent, type ChannelState } from '@kernel/rpc/contract'
import {
  workspaceSettingsTable,
  type SetSettingParams,
  type SettingsTable,
  type WorkspaceSettingKey,
  type WorkspaceSettings,
} from '../contract'

const RESTART_MS = 1_000

type SettingsEvent = ChannelEvent<WorkspaceSettings, Partial<WorkspaceSettings>>

/** The part of the `settings` proxy the mirror uses. */
export interface WorkspaceSettingsRemote {
  set(params: SetSettingParams): Promise<void>
  subscribe(params: undefined, options: { resume: true }): {
    onEvent(listener: (event: SettingsEvent) => void): () => void
    cancel(): void
    readonly done: Promise<unknown>
  }
}

export interface WorkspaceSettingsMirror {
  /** Resolves with the first snapshot. */
  readonly ready: Promise<void>
  /** Runtime values with pending local edits on top; defaults before the
   *  first snapshot. */
  getAll(): WorkspaceSettings
  get<K extends WorkspaceSettingKey>(key: K): WorkspaceSettings[K]
  /** Applies at once; rejects (and reverts) when the value is invalid or the
   *  runtime refuses it. */
  set<K extends WorkspaceSettingKey>(key: K, value: WorkspaceSettings[K]): Promise<void>
  subscribe(cb: (values: WorkspaceSettings) => void): () => void
  dispose(): void
}

export function createWorkspaceSettingsMirror(
  remote: WorkspaceSettingsRemote,
  table: SettingsTable<WorkspaceSettings> = workspaceSettingsTable,
): WorkspaceSettingsMirror {
  let confirmed: ChannelState<WorkspaceSettings> | null = null
  const pending = new Map<string, { seq: number; value: unknown }>()
  const listeners = new Set<(values: WorkspaceSettings) => void>()
  let seq = 0
  let disposed = false
  let markReady!: () => void
  const ready = new Promise<void>((resolve) => { markReady = resolve })

  const values = (): WorkspaceSettings => {
    const base = confirmed?.snapshot ?? table.defaults
    if (pending.size === 0) return { ...base }
    const next: Record<string, unknown> = { ...base }
    for (const [key, edit] of pending) next[key] = edit.value
    return next as WorkspaceSettings
  }

  const notify = (): void => {
    const snapshot = values()
    for (const cb of listeners) {
      try { cb(snapshot) } catch { /* isolate listeners */ }
    }
  }

  let subscription: ReturnType<WorkspaceSettingsRemote['subscribe']>
  let offEvent: () => void = () => {}

  const open = (): void => {
    // Resumed across reconnects. One the runtime ends starts over a moment
    // later; one that fails (a closed client, no such capability) stays ended.
    const current = remote.subscribe(undefined, { resume: true })
    subscription = current
    current.done.then(() => {
      setTimeout(() => { if (!disposed && subscription === current) open() }, RESTART_MS)
    }, () => {})
    offEvent = current.onEvent((event) => {
      const next = reduceChannel(confirmed, event, applyShallowPatch)
      if (!next) {
        // Missed a change: start over from a fresh snapshot.
        offEvent()
        subscription.cancel()
        if (!disposed) open()
        return
      }
      confirmed = next
      if (event.kind === 'snapshot') markReady()
      notify()
    })
  }
  open()

  return {
    ready,
    getAll: values,
    get: (key) => values()[key],
    async set(key, value) {
      if (!table.validate(key, value)) throw new RpcError('rejected', `Invalid value for setting "${key}"`)
      const mine = ++seq
      pending.set(key, { seq: mine, value })
      notify()
      try {
        await remote.set({ key, value })
      } finally {
        if (pending.get(key)?.seq === mine) {
          pending.delete(key)
          notify()
        }
      }
    },
    subscribe(cb) {
      listeners.add(cb)
      return () => { listeners.delete(cb) }
    },
    dispose() {
      disposed = true
      listeners.clear()
      offEvent()
      subscription.cancel()
    },
  }
}
