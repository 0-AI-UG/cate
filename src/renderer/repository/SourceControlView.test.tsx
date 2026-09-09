import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SourceControlView } from './SourceControlView'
import { useUIStore } from '../stores/uiStore'
const h = vi.hoisted(() => ({ refresh: vi.fn(), review: vi.fn(async () => null) }))
vi.mock('../lib/review/openReviewPanel', () => ({ openReviewPanel: h.review }))
vi.mock('../stores/gitStatusStore', () => ({
  workspaceIdForRoot: () => 'ws', gitStatusStore: { refresh: h.refresh },
  useGitStatusSnapshot: (root: string) => ({ isRepo: true, branch: root === '/repo' ? 'main' : 'feature', ahead: 0, behind: 0, statusFiles: [{ path: 'partial.ts', index: 'M', working_dir: 'M' }] }),
}))
vi.mock('../stores/useWorktrees', () => ({ useWorktrees: () => [
  { id: 'main', path: '/repo', branch: 'main', isPrimary: true },
  { id: 'feature', path: '/repo/feature', branch: 'feature', isPrimary: false },
] }))
let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  useUIStore.setState({ sourceControlWorktreeByRepository: {}, sourceControlDrafts: { '/repo': 'main draft', '/repo/feature': 'feature draft' } })
  Object.assign(window.electronAPI, { gitLog: vi.fn().mockResolvedValue([]), gitBranchList: vi.fn().mockResolvedValue({ branches: [] }), gitStage: vi.fn().mockResolvedValue(undefined) })
})
afterEach(() => { act(() => root.unmount()); host.remove() })
it('scopes files and drafts to Changes while history remains on the repository root', async () => {
  await act(async () => root.render(<SourceControlView workspaceId="ws" rootPath="/repo" />))
  expect(host.querySelector('textarea')!.value).toBe('main draft')
  const select = host.querySelector('select')!
  await act(async () => { select.value = 'feature'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(host.querySelector('textarea')!.value).toBe('feature draft')
  expect(window.electronAPI.gitLog).toHaveBeenLastCalledWith('/repo', 30, 'ws')
  // A partially staged file still exposes its remaining unstaged changes.
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Stage file"]')!.click())
  expect(window.electronAPI.gitStage).toHaveBeenCalledWith('/repo/feature', 'partial.ts', 'ws')
  await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === 'History')!.click())
  expect(host.querySelector('select')).toBeNull()
  expect(host.querySelector('textarea')).toBeNull()
})

it('review buttons declare overlay routing and dismiss the overlay for the picker', async () => {
  useUIStore.setState({ showPullRequests: true })
  await act(async () => root.render(<SourceControlView workspaceId="ws" rootPath="/repo" />))
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Review staged changes"]')!.click())
  expect(h.review).toHaveBeenCalledWith({ workspaceId: 'ws', repoPath: '/repo', spec: { kind: 'staged' }, focusedFile: undefined, openNew: false, source: 'overlay' })
  expect(useUIStore.getState().showPullRequests).toBe(false)
})
