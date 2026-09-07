import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { refreshAgentChanges, useAgentChanges } from './useAgentChanges'
import type { AgentChangesSnapshot } from '../../shared/agentChanges'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const roots: ReturnType<typeof createRoot>[] = []
function View({ cwd = '/repo' }: { cwd?: string }) { const snapshot = useAgentChanges(cwd, 'ws'); return <span>{snapshot.loading ? 'loading' : snapshot.error ?? snapshot.records.length}</span> }
function mount(children: React.ReactNode) {
  const host = document.createElement('div'), root = createRoot(host)
  roots.push(root)
  act(() => root.render(children))
  return { root, host }
}
afterEach(async () => { for (const root of roots.splice(0)) act(() => root.unmount()); await Promise.resolve(); vi.useRealTimers() })

it('waits for the shared in-flight poll when manually refreshing', async () => {
  let resolve!: (value: AgentChangesSnapshot) => void
  const list = vi.fn(() => new Promise<AgentChangesSnapshot>((done) => { resolve = done }))
  window.electronAPI = { agentChangesRead: list } as any
  mount(<><View /><View /></>)
  let finished = false
  const refresh = refreshAgentChanges('/repo', 'ws').then(() => { finished = true })
  await act(async () => { await Promise.resolve() })
  expect(list).toHaveBeenCalledTimes(1)
  expect(finished).toBe(false)
  await act(async () => { resolve({ revision: '1', records: [] }); await refresh })
  expect(finished).toBe(true)
})

it('ignores a stale checkout response and stops polling after the last subscriber', async () => {
  vi.useFakeTimers()
  let resolveOld!: (value: AgentChangesSnapshot) => void
  const list = vi.fn((cwd: string) => cwd === '/old' ? new Promise<AgentChangesSnapshot>((done) => { resolveOld = done }) : Promise.resolve({ revision: 'new', records: [] }))
  window.electronAPI = { agentChangesRead: list } as any
  const { root, host } = mount(<View cwd="/old" />)
  await act(async () => root.render(<View cwd="/new" />))
  await act(async () => resolveOld({ revision: 'old', records: [{} as any] }))
  expect(host.textContent).toBe('0')
  await act(async () => root.render(null))
  const count = list.mock.calls.length
  await act(async () => vi.advanceTimersByTimeAsync(6000))
  expect(list).toHaveBeenCalledTimes(count)
})

it('recovers after a polling error and survives StrictMode effect replay', async () => {
  vi.useFakeTimers()
  const list = vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValue({ revision: '1', records: [] })
  window.electronAPI = { agentChangesRead: list } as any
  const { host } = mount(<React.StrictMode><View /></React.StrictMode>)
  await act(async () => { await Promise.resolve() })
  expect(host.textContent).toBe('Offline')
  await act(async () => vi.advanceTimersByTimeAsync(2000))
  expect(host.textContent).toBe('0')
})

it('uses revision reads without replacing unchanged records', async () => {
  const records: any[] = [{ id: 'record' }]
  const list = vi.fn().mockResolvedValueOnce({ revision: '1', records }).mockResolvedValue({ revision: '1' })
  window.electronAPI = { agentChangesRead: list } as any
  let observed: any
  function Observe() { observed = useAgentChanges('/repo', 'ws'); return null }
  mount(<Observe />)
  await act(async () => { await Promise.resolve() })
  const first = observed
  await act(async () => refreshAgentChanges('/repo', 'ws'))
  expect(list).toHaveBeenLastCalledWith('/repo', 'ws', '1')
  expect(observed).toBe(first)
})
