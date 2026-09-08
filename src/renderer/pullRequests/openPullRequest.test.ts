import { beforeEach, expect, it, vi } from 'vitest'
import type { PullRequestItem } from '../../shared/pullRequests'
const mocks = vi.hoisted(() => ({ state: {} as any, checkout: vi.fn(), reveal: vi.fn(), hide: vi.fn() }))
vi.mock('../stores/appStore', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('../stores/uiStore', () => ({ useUIStore: { getState: () => ({ setShowPullRequests: mocks.hide }) } }))
vi.mock('../stores/useWorktreeActions', () => ({ checkoutPrForWorkspace: mocks.checkout }))
vi.mock('../lib/workspace/canvasAccess', () => ({ getWorkspaceCanvasPanelId: () => 'canvas' }))
vi.mock('../lib/workspace/panelReveal', () => ({ revealPanel: mocks.reveal }))
import { openPullRequest } from './openPullRequest'
const pr = { number: 42, title: 'Fix startup', repository: 'org/repo', author: 'alice' } as PullRequestItem
beforeEach(() => {
  vi.clearAllMocks()
  const workspace = { id: 'ws', rootPath: '/repo', panels: {}, worktrees: [] }
  mocks.state = {
    workspaces: [workspace], selectedWorkspaceId: 'ws', getWorkspace: () => workspace,
    selectWorkspace: vi.fn(), ensureCenterCanvas: vi.fn(), createTerminal: vi.fn().mockReturnValue('terminal'),
    createAgent: vi.fn().mockReturnValue('agent'), createReview: vi.fn().mockReturnValue('review'),
    setPanelWorktreeId: vi.fn(), updatePanelTitle: vi.fn(), setPanelReviewState: vi.fn(),
  }
  mocks.checkout.mockResolvedValue({ id: 'wt', path: '/repo/.cate/worktrees/pr-42-fix' })
  vi.stubGlobal('window', { electronAPI: { githubPrContext: vi.fn().mockResolvedValue({ headRefName: 'fix', baseOid: 'a'.repeat(40) }) } })
})
it('opens an isolated checkout with review, terminal and agent on the same canvas', async () => {
  await openPullRequest(pr)
  expect(mocks.checkout).toHaveBeenCalledWith('/repo', 'ws', expect.objectContaining({ number: 42, headRefName: 'fix' }))
  expect(mocks.state.createTerminal).toHaveBeenCalledWith('ws', undefined, undefined, { target: 'canvas', canvasPanelId: 'canvas' }, '/repo/.cate/worktrees/pr-42-fix')
  expect(mocks.state.createAgent).toHaveBeenCalledWith('ws', undefined, { target: 'canvas', canvasPanelId: 'canvas' }, '/repo/.cate/worktrees/pr-42-fix', 'wt')
  expect(mocks.state.createReview).toHaveBeenCalledWith('ws', '/repo/.cate/worktrees/pr-42-fix', { spec: { kind: 'branch', base: 'a'.repeat(40), target: 'HEAD' } }, undefined, { target: 'canvas', canvasPanelId: 'canvas' })
  expect(mocks.reveal).toHaveBeenCalledWith('ws', 'review', { retry: true })
  expect(mocks.hide).toHaveBeenCalledWith(false)
})
it('reopens an existing PR without duplicating its worktree or panels', async () => {
  const workspace = mocks.state.workspaces[0]
  workspace.worktrees = [{ id: 'wt', path: '/wt', prNumber: 42 }]
  workspace.panels = {
    terminal: { id: 'terminal', type: 'terminal', worktreeId: 'wt' },
    agent: { id: 'agent', type: 'agent', worktreeId: 'wt' },
    review: { id: 'review', type: 'review', reviewState: { repoPath: '/wt' } },
  }
  await openPullRequest(pr)
  expect(mocks.checkout).not.toHaveBeenCalled()
  expect(mocks.state.createTerminal).not.toHaveBeenCalled()
  expect(mocks.state.createAgent).not.toHaveBeenCalled()
  expect(mocks.state.createReview).not.toHaveBeenCalled()
  expect(mocks.state.setPanelReviewState).toHaveBeenCalled()
})
it('keeps the overview open when no matching project is available', async () => {
  vi.mocked(window.electronAPI.githubPrContext).mockResolvedValue(null)
  await expect(openPullRequest(pr)).rejects.toThrow('Open your local org/repo project')
  expect(mocks.checkout).not.toHaveBeenCalled()
  expect(mocks.hide).not.toHaveBeenCalled()
})
it('keeps the overview open and surfaces checkout failures', async () => {
  mocks.checkout.mockRejectedValue(new Error('Checkout failed'))
  await expect(openPullRequest(pr)).rejects.toThrow('Checkout failed')
  expect(mocks.state.createTerminal).not.toHaveBeenCalled()
  expect(mocks.hide).not.toHaveBeenCalled()
})
