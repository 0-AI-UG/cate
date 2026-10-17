import { describe, expect, it, vi } from 'vitest'
import { RpcError, type ChannelEvent } from '@kernel/rpc/contract'
import { type SetSettingParams } from '../contract'
import { createWorkspaceSettingsMirror, type WorkspaceSettingsRemote } from './workspaceSettingsMirror'
import { workspaceSettingsTable, type WorkspaceSettings } from '@panels/settings'

type Event = ChannelEvent<WorkspaceSettings, Partial<WorkspaceSettings>>

function fakeRemote() {
  let listener: ((e: Event) => void) | null = null
  let values: WorkspaceSettings = { ...workspaceSettingsTable.defaults }
  let rev = 0
  const calls: Array<{ params: SetSettingParams; resolve: () => void; reject: (e: unknown) => void }> = []
  const subscribes = vi.fn()
  const remote: WorkspaceSettingsRemote = {
    set: (params) => new Promise<void>((resolve, reject) => { calls.push({ params, resolve, reject }) }),
    subscribe: () => {
      subscribes()
      return {
        onEvent: (l) => {
          listener = l
          queueMicrotask(() => { rev = 0; l({ kind: 'snapshot', rev, snapshot: { ...values } }) })
          return () => { listener = null }
        },
        cancel: () => {},
        done: new Promise(() => {}),
      }
    },
  }
  const change = (patch: Partial<WorkspaceSettings>, skip = false) => {
    values = { ...values, ...patch }
    rev += skip ? 2 : 1
    listener?.({ kind: 'change', rev, change: patch })
  }
  return { remote, calls, change, subscribes }
}

describe('workspace settings mirror', () => {
  it('shows an edit at once and keeps it when the runtime confirms', async () => {
    const { remote, calls, change } = fakeRemote()
    const mirror = createWorkspaceSettingsMirror(remote, workspaceSettingsTable)
    await mirror.ready
    const seen = vi.fn()
    mirror.subscribe((v) => seen(v.runtimeLifetime))

    const done = mirror.set('runtimeLifetime', 'keepRunning')
    expect(mirror.get('runtimeLifetime')).toBe('keepRunning')
    // Another client's change to the same key does not override the pending edit.
    change({ runtimeLifetime: 'stopWhenIdle' })
    expect(mirror.get('runtimeLifetime')).toBe('keepRunning')
    change({ runtimeLifetime: 'keepRunning' })
    calls[0].resolve()
    await done
    expect(mirror.get('runtimeLifetime')).toBe('keepRunning')
    expect(seen).toHaveBeenCalledWith('keepRunning')
  })

  it('reverts a refused edit', async () => {
    const { remote, calls } = fakeRemote()
    const mirror = createWorkspaceSettingsMirror(remote, workspaceSettingsTable)
    await mirror.ready
    const done = mirror.set('cliEnabled', false)
    expect(mirror.get('cliEnabled')).toBe(false)
    calls[0].reject(new RpcError('rejected'))
    await expect(done).rejects.toThrow()
    expect(mirror.get('cliEnabled')).toBe(true)
  })

  it('rejects invalid values locally without calling the runtime', async () => {
    const { remote, calls } = fakeRemote()
    const mirror = createWorkspaceSettingsMirror(remote, workspaceSettingsTable)
    // @ts-expect-error invalid value
    await expect(mirror.set('runtimeNetwork', 'lan')).rejects.toThrow(/Invalid/)
    expect(calls).toHaveLength(0)
  })

  it('applies remote changes and resubscribes after a gap', async () => {
    const { remote, change, subscribes } = fakeRemote()
    const mirror = createWorkspaceSettingsMirror(remote, workspaceSettingsTable)
    await mirror.ready
    change({ browserHomepage: 'https://a.dev' })
    expect(mirror.get('browserHomepage')).toBe('https://a.dev')
    change({ browserHomepage: 'https://b.dev' }, true)
    expect(subscribes).toHaveBeenCalledTimes(2)
    await Promise.resolve()
    expect(mirror.get('browserHomepage')).toBe('https://b.dev')
    mirror.dispose()
  })
})
