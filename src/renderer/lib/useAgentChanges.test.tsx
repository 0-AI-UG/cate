import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { activeAgentChanges, refreshAgentChanges, useAgentChanges } from './useAgentChanges'
import type { AgentChangeRecord, AgentChangesSnapshot } from '../../shared/agentChanges'
import type { GitStatusSnapshot } from '../stores/gitStatusStore'

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

const record = (id: string, path: string, oldPath?: string): AgentChangeRecord => ({
  id, agentId: 'codex', sessionId: 'session', turnId: id, source: 't3', sourceId: 'thread', cwd: '/repo',
  createdAt: '2026-01-01T00:00:00Z', mode: 'operation',
  files: [{ path, oldPath, patch: '', hunks: [], additions: 1, deletions: 1, coverage: 'patch' }],
})
const git = (statusFiles: GitStatusSnapshot['statusFiles'], isRepo = true): GitStatusSnapshot => ({
  isRepo, statusFiles, tracked: new Set(), branch: 'main', ahead: 0, behind: 0, worktrees: [], revision: 1,
})

it('keeps only agent files with staged or unstaged Git changes without deleting history', () => {
  const history = [record('active', 'src/a.ts'), record('committed', 'src/b.ts'), record('renamed', 'src/new.ts', 'src/old.ts')]
  const active = activeAgentChanges(history, git([
    { path: 'src/a.ts', index: ' ', working_dir: 'M' },
    { path: 'src/old.ts', index: 'R', working_dir: ' ' },
  ]))
  expect(active.map((item) => item.id)).toEqual(['active', 'renamed'])
  expect(history).toHaveLength(3)
  expect(activeAgentChanges(history, git([]))).toEqual([])
  expect(activeAgentChanges(history, git([], false))).toEqual(history)
})

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
