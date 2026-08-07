import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  workspace: {} as any,
  setPanelCodingAgentRun: vi.fn(),
  removeWorktree: vi.fn(),
  removeAdditionalRoot: vi.fn(),
  refresh: vi.fn(),
}))

vi.mock('../../stores/appStore', () => ({
  useAppStore: {
    getState: () => ({
      workspaces: [state.workspace],
      setPanelCodingAgentRun: state.setPanelCodingAgentRun,
      removeWorktree: state.removeWorktree,
      removeAdditionalRoot: state.removeAdditionalRoot,
    }),
  },
}))
vi.mock('../../stores/gitStatusStore', () => ({
  gitStatusStore: { refresh: state.refresh },
}))

import {
  applyCodingAgentWorktree,
  discardCodingAgentWorktree,
  keepCodingAgentWorktree,
  reviewCodingAgentWorktree,
} from './codingAgentIntegration'

describe('coding-agent worktree integration', () => {
  const review = {
    branch: 'agent/api',
    baseBranch: 'main',
    dirty: false,
    canApply: true,
    commits: [{ hash: 'abc', message: 'Implement API' }],
    files: [{ status: 'M', path: 'api.ts' }],
    workingFiles: [],
    diff: 'diff',
    truncated: false,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    state.workspace = {
      id: 'ws',
      rootPath: '/repo',
      panels: {
        worker: {
          id: 'worker',
          codingAgentRun: {
            id: 'run-1',
            panelId: 'worker',
            agentId: 'codex',
            ownerPanelId: 'supervisor',
            prompt: 'Implement it',
            createdAt: 1,
            worktreeId: 'wt-1',
            ownsWorktree: true,
          },
        },
      },
      worktrees: [{ id: 'wt-1', path: '/repo-wt', branch: 'agent/api' }],
    }
    vi.stubGlobal('window', {
      electronAPI: {
        gitStatus: vi.fn(async () => ({ current: 'main' })),
        gitWorktreeReview: vi.fn(async () => review),
        gitWorktreeMergeTo: vi.fn(async () => ({ ok: true, result: {} })),
        gitWorktreeStatus: vi.fn(async () => ({ branch: 'agent/api', dirty: false })),
        gitWorktreeRemove: vi.fn(async () => {}),
        gitBranchDelete: vi.fn(async () => {}),
      },
    })
  })

  it('reviews against the primary checkout current branch', async () => {
    await expect(reviewCodingAgentWorktree('ws', 'worker')).resolves.toEqual(review)
    expect(window.electronAPI.gitWorktreeReview).toHaveBeenCalledWith('/repo-wt', 'main', 'ws')
  })

  it('rechecks readiness and records a successful guarded merge', async () => {
    await expect(applyCodingAgentWorktree('ws', 'worker'))
      .resolves.toEqual({ ok: true, branch: 'main' })

    expect(window.electronAPI.gitWorktreeMergeTo)
      .toHaveBeenCalledWith('/repo', 'agent/api', 'main', 'ws')
    expect(state.setPanelCodingAgentRun).toHaveBeenCalledWith(
      'ws',
      'worker',
      expect.objectContaining({ appliedAt: expect.any(Number), appliedToBranch: 'main' }),
    )
  })

  it('refuses to merge a dirty or uncommitted worker', async () => {
    vi.mocked(window.electronAPI.gitWorktreeReview).mockResolvedValueOnce({
      ...review,
      dirty: true,
      canApply: false,
      message: 'Commit first.',
    })

    await expect(applyCodingAgentWorktree('ws', 'worker'))
      .resolves.toEqual({ ok: false, message: 'Commit first.' })
    expect(window.electronAPI.gitWorktreeMergeTo).not.toHaveBeenCalled()
  })

  it('requires another review when the user switches target branches', async () => {
    vi.mocked(window.electronAPI.gitStatus).mockResolvedValueOnce({ current: 'develop' } as never)
    vi.mocked(window.electronAPI.gitWorktreeReview).mockResolvedValueOnce({
      ...review,
      baseBranch: 'develop',
    })

    await expect(applyCodingAgentWorktree('ws', 'worker', 'main')).resolves.toEqual({
      ok: false,
      message: 'The current branch changed from main to develop. Review again before applying.',
    })
    expect(window.electronAPI.gitWorktreeMergeTo).not.toHaveBeenCalled()
  })

  it('records an explicit decision to keep the isolated worktree', () => {
    keepCodingAgentWorktree('ws', 'worker')

    expect(state.setPanelCodingAgentRun).toHaveBeenCalledWith(
      'ws',
      'worker',
      expect.objectContaining({ keptAt: expect.any(Number) }),
    )
  })

  it('removes only a mission-owned worktree and clears its run association', async () => {
    await discardCodingAgentWorktree('ws', 'worker')

    expect(window.electronAPI.gitWorktreeRemove)
      .toHaveBeenCalledWith('/repo', '/repo-wt', { force: false }, 'ws')
    expect(window.electronAPI.gitBranchDelete)
      .toHaveBeenCalledWith('/repo', 'agent/api', true, 'ws')
    expect(state.removeWorktree).toHaveBeenCalledWith('ws', 'wt-1')
    expect(state.setPanelCodingAgentRun).toHaveBeenCalledWith(
      'ws',
      'worker',
      expect.objectContaining({ worktreeId: undefined, ownsWorktree: false }),
    )
  })
})
