// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JoinedWorktree } from '../stores/useWorktrees'

vi.hoisted(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: vi.fn(() => null),
  })
})

vi.mock('../stores/gitStatusStore', () => ({
  gitStatusStore: { refresh: vi.fn() },
}))

const { revealPanel } = vi.hoisted(() => ({ revealPanel: vi.fn(async () => undefined) }))
vi.mock('../lib/workspace/panelReveal', () => ({ revealPanel }))

import { useAppStore } from '../stores/appStore'
import {
  branchComparisonSpec,
  openOrRevealAgentForWorktree,
  resolveAgentWorktree,
  worktreeChangeCount,
} from './AgentWorkspaceBar'

const ROOT = '/repo'
const WORKTREE = '/repo/.cate/worktrees/feature'
const primary: JoinedWorktree = {
  id: 'primary',
  path: ROOT,
  branch: 'main',
  isPrimary: true,
  isCurrent: true,
  isOrphan: false,
}
const feature: JoinedWorktree = {
  id: 'feature',
  path: WORKTREE,
  branch: 'feature',
  isPrimary: false,
  isCurrent: false,
  isOrphan: false,
}
const initialState = useAppStore.getState()

beforeEach(() => {
  revealPanel.mockReset().mockResolvedValue(undefined)
  useAppStore.setState({
    ...initialState,
    selectedWorkspaceId: 'ws',
    workspaces: [{
      id: 'ws',
      name: 'Repo',
      color: '',
      rootPath: ROOT,
      worktrees: [
        { id: primary.id, path: primary.path, color: '#111111' },
        { id: feature.id, path: feature.path, color: '#222222' },
      ],
      panels: {
        existing: {
          id: 'existing',
          type: 'agent',
          title: 'Agent',
          isDirty: false,
          cwd: ROOT,
          worktreeId: primary.id,
          agentThreadId: 'thread-1',
        },
      },
    }],
  }, true)
})

describe('AgentWorkspaceBar worktree binding', () => {
  it('resolves an explicit id, then cwd, then the primary worktree only when unbound', () => {
    expect(resolveAgentWorktree({ worktreeId: feature.id }, [primary, feature])).toBe(feature)
    expect(resolveAgentWorktree({ cwd: WORKTREE }, [primary, feature])).toBe(feature)
    expect(resolveAgentWorktree(undefined, [primary, feature])).toBe(primary)
    expect(resolveAgentWorktree({ worktreeId: 'missing' }, [primary, feature])).toBeUndefined()
    expect(resolveAgentWorktree({ cwd: '/missing' }, [primary, feature])).toBeUndefined()
  })

  it('creates an Agent only when the checkout has no existing panel', async () => {
    const newPanelId = await openOrRevealAgentForWorktree('ws', feature)
    const panels = useAppStore.getState().workspaces[0].panels

    expect(panels.existing).toMatchObject({
      cwd: ROOT,
      worktreeId: primary.id,
      agentThreadId: 'thread-1',
    })
    expect(panels[newPanelId]).toMatchObject({
      type: 'agent',
      cwd: WORKTREE,
      worktreeId: feature.id,
    })
    expect(panels[newPanelId].agentThreadId).toBeUndefined()
  })

  it('reveals an Agent already bound to the selected checkout', async () => {
    const panelId = await openOrRevealAgentForWorktree('ws', primary)
    const panels = useAppStore.getState().workspaces[0].panels

    expect(panelId).toBe('existing')
    expect(Object.keys(panels)).toEqual(['existing'])
    expect(revealPanel).toHaveBeenCalledWith('ws', 'existing', { retry: true })
  })

  it('builds review facts from Cate git status', () => {
    expect(worktreeChangeCount({
      branch: 'feature',
      dirty: true,
      ahead: 0,
      behind: 0,
      staged: 2,
      unstaged: 3,
      untracked: 1,
    })).toBe(6)
    expect(branchComparisonSpec(feature, 'main')).toEqual({
      kind: 'branch',
      base: 'main',
      target: 'feature',
    })
    expect(branchComparisonSpec(primary, 'main')).toBeNull()
    expect(branchComparisonSpec(feature, '')).toBeNull()
  })
})
