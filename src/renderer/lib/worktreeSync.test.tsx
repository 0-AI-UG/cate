import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: vi.fn(() => null),
  })
})

import { useAppStore } from '../stores/appStore'
import { syncWorktrees, type GitWorktree } from './worktreeSync'

const ROOT = '/repo'
const FEATURE = `${ROOT}/.cate/worktrees/feature`
const THIRD = `${ROOT}/.cate/worktrees/third`
const initialAppState = useAppStore.getState()

function gitWorktree(path: string, branch: string): GitWorktree {
  return { path, branch, isBare: false, isCurrent: path === ROOT }
}

beforeEach(() => {
  useAppStore.setState({
    ...initialAppState,
    workspaces: [{
      id: 'ws',
      name: 'Repo',
      color: '',
      rootPath: ROOT,
      panels: {},
    }],
    selectedWorkspaceId: 'ws',
  }, true)
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    gitIsRepo: vi.fn().mockResolvedValue(true),
    gitWorktreeList: vi.fn().mockResolvedValue([
      gitWorktree(ROOT, 'main'),
      gitWorktree(FEATURE, 'feature'),
    ]),
  }
})

afterEach(() => {
  useAppStore.setState(initialAppState, true)
})

describe('syncWorktrees', () => {
  it('assigns distinct colors when the primary and first secondary worktree are discovered together', async () => {
    await syncWorktrees('ws')

    const firstSync = useAppStore.getState().workspaces[0].worktrees ?? []
    expect(firstSync.map((worktree) => worktree.path)).toEqual([ROOT, FEATURE])
    expect(new Set(firstSync.map((worktree) => worktree.color)).size).toBe(2)

    vi.mocked(window.electronAPI.gitWorktreeList).mockResolvedValueOnce([
      gitWorktree(ROOT, 'main'),
      gitWorktree(FEATURE, 'feature'),
      gitWorktree(THIRD, 'third'),
    ])
    await syncWorktrees('ws')

    const secondSync = useAppStore.getState().workspaces[0].worktrees ?? []
    expect(secondSync.map((worktree) => worktree.path)).toEqual([ROOT, FEATURE, THIRD])
    expect(new Set(secondSync.map((worktree) => worktree.color)).size).toBe(3)
  })
})
