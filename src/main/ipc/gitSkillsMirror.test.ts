import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GIT_WORKTREE_ADD, GIT_WORKTREE_ADD_FROM_PR } from '../../shared/ipc-channels'

const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  worktreeAdd: vi.fn(),
  worktreeAddFromPr: vi.fn(),
  sync: vi.fn(),
  getWorkspaceInfo: vi.fn(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      state.handlers.set(channel, handler)
    }),
  },
}))
vi.mock('../runtime/runtimeManager', () => ({
  resolveLocator: vi.fn(() => ({
    runtimeId: 'local',
    path: '/repo',
    runtime: {
      vcs: {
        worktreeAdd: state.worktreeAdd,
        worktreeAddFromPr: state.worktreeAddFromPr,
      },
    },
  })),
}))
vi.mock('../windowRegistry', () => ({ windowFromEvent: () => ({ id: 7 }) }))
vi.mock('../workspaceManager', () => ({ getWorkspaceInfo: state.getWorkspaceInfo }))
vi.mock('../../skills/main/skillsMirror', () => ({ syncWorkspaceSkills: state.sync }))
vi.mock('../logger', () => ({ default: { warn: vi.fn() } }))

import { registerHandlers } from './git'

describe('git worktree skill mirroring', () => {
  beforeEach(() => {
    state.handlers.clear()
    state.worktreeAdd.mockReset().mockResolvedValue({
      path: '/repo/.cate/worktrees/feature',
      branch: 'feature',
    })
    state.worktreeAddFromPr.mockReset().mockResolvedValue({
      path: '/repo/.cate/worktrees/pr-12',
      branch: 'pr-12',
    })
    state.sync.mockReset().mockResolvedValue({
      copied: [],
      updated: [],
      removed: [],
      preserved: [],
      warnings: [],
    })
    state.getWorkspaceInfo.mockReset().mockReturnValue({ rootPath: '/repo/base' })
    registerHandlers()
  })

  it('hydrates a newly-created worktree from the logical workspace root', async () => {
    const result = await state.handlers.get(GIT_WORKTREE_ADD)!(
      {},
      '/repo',
      'feature',
      '/repo/.cate/worktrees/feature',
      { createBranch: true },
      'workspace-1',
    )

    expect(state.sync).toHaveBeenCalledWith('/repo/base', '/repo/.cate/worktrees/feature')
    expect(result).toMatchObject({ path: '/repo/.cate/worktrees/feature', branch: 'feature' })
  })

  it('hydrates a PR worktree through the same path', async () => {
    await state.handlers.get(GIT_WORKTREE_ADD_FROM_PR)!(
      {},
      '/repo',
      12,
      '/repo/.cate/worktrees/pr-12',
      undefined,
      'workspace-1',
    )

    expect(state.sync).toHaveBeenCalledWith('/repo/base', '/repo/.cate/worktrees/pr-12')
  })
})
