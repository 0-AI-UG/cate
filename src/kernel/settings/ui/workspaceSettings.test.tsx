import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { setRuntimeResolver } from '@kernel/rpc/client'
import type { ChannelEvent, RuntimeProxy } from '@kernel/rpc/contract'
import { workspaceSettingsTable, type WorkspaceSettings } from '../contract'
import { setWorkspaceSetting, useWorkspaceSetting, workspaceSettingsFor } from './index'

type Event = ChannelEvent<WorkspaceSettings, Partial<WorkspaceSettings>>

function fakeRuntime() {
  let listener: ((e: Event) => void) | null = null
  let rev = 0
  const set = vi.fn(async ({ key, value }: { key: string; value: unknown }) => {
    listener?.({ kind: 'change', rev: ++rev, change: { [key]: value } })
  })
  const runtime = {
    settings: {
      set,
      subscribe: () => ({
        onEvent: (l: (e: Event) => void) => {
          listener = l
          queueMicrotask(() => l({ kind: 'snapshot', rev, snapshot: { ...workspaceSettingsTable.defaults, cliEnabled: false } }))
          return () => { listener = null }
        },
        cancel: () => {},
      }),
    },
  } as unknown as RuntimeProxy
  return { runtime, set }
}

let uninstall: () => void = () => {}
afterEach(() => uninstall())

describe('workspace settings hooks', () => {
  it('mirror the open workspace and send edits to its runtime', async () => {
    const { runtime, set } = fakeRuntime()
    uninstall = setRuntimeResolver((id) => (id === 'w1' ? runtime : null))
    const host = document.createElement('div')
    const root = createRoot(host)
    function Probe() {
      return <span>{String(useWorkspaceSetting('w1', 'cliEnabled'))}</span>
    }
    act(() => root.render(<Probe />))
    await act(async () => { await workspaceSettingsFor('w1')!.ready })
    expect(host.textContent).toBe('false')
    await act(async () => { await setWorkspaceSetting('w1', 'cliEnabled', true) })
    expect(set).toHaveBeenCalledWith({ key: 'cliEnabled', value: true })
    expect(host.textContent).toBe('true')
    act(() => root.unmount())
  })

  it('read defaults and refuse edits while the workspace is not open', async () => {
    uninstall = setRuntimeResolver(() => null)
    expect(workspaceSettingsFor('w2')).toBeNull()
    await expect(setWorkspaceSetting('w2', 'cliEnabled', false)).rejects.toThrow(/not open/)
  })
})
