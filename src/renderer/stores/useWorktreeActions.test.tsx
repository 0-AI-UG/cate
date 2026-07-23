import React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const h = vi.hoisted(() => {
  // appStore's import graph initializes the optional worktree territory canvas.
  // jsdom logs for every getContext call unless the API is stubbed locally.
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: vi.fn(() => null),
  })
  return {
    refresh: vi.fn(),
    newWorktreeId: vi.fn(() => 'wt-test'),
  }
})

vi.mock('./gitStatusStore', () => ({
  gitStatusStore: { refresh: h.refresh },
}))

vi.mock('../lib/worktreeSync', () => ({
  newWorktreeId: h.newWorktreeId,
}))

import { useAppStore } from './appStore'
import { useSettingsStore } from './settingsStore'
import { useWorktreeActions, type WorktreeActions } from './useWorktreeActions'

const ROOT = '/repo/'
const WS = 'ws-1'

let host: HTMLDivElement
let root: Root
let actions: WorktreeActions
const initialAppState = useAppStore.getState()
const initialSettingsState = useSettingsStore.getState()

function Probe(): React.ReactElement {
  actions = useWorktreeActions(ROOT, WS)
  return <div />
}

function workspace() {
  return useAppStore.getState().workspaces.find((ws) => ws.id === WS)!
}

beforeEach(() => {
  h.refresh.mockReset()
  h.newWorktreeId.mockReset().mockReturnValue('wt-test')
  useAppStore.setState({
    ...initialAppState,
    workspaces: [{
      id: WS,
      name: 'Repo',
      color: '',
      rootPath: '/repo',
      panels: {},
      worktrees: [{ id: 'primary', path: '/repo', color: '#112233' }],
    }],
    selectedWorkspaceId: WS,
  }, true)
  useSettingsStore.setState({
    ...initialSettingsState,
    worktreeSymlinkPaths: [' node_modules ', '', ' .env.local '],
  }, true)
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    gitWorktreeAdd: vi.fn().mockResolvedValue(undefined),
    gitWorktreeAddFromPr: vi.fn(),
  }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<Probe />))
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useAppStore.setState(initialAppState, true)
  useSettingsStore.setState(initialSettingsState, true)
})

describe('useWorktreeActions', () => {
  it('creates a sanitized branch, then registers and refreshes its worktree', async () => {
    await act(async () => {
      await actions.createWorktree('  Fix login bug!  ', 'origin/release')
    })

    expect(window.electronAPI.gitWorktreeAdd).toHaveBeenCalledWith(
      ROOT,
      'Fix-login-bug',
      '/repo/.cate/worktrees/Fix-login-bug',
      {
        createBranch: true,
        baseRef: 'origin/release',
        symlinkPaths: ['node_modules', '.env.local'],
      },
      WS,
    )
    expect(workspace().worktrees).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'wt-test',
        path: '/repo/.cate/worktrees/Fix-login-bug',
        label: 'Fix login bug!',
      }),
    ]))
    expect(workspace().additionalRoots).toContain('/repo/.cate/worktrees/Fix-login-bug')
    expect(h.refresh).toHaveBeenCalledWith(ROOT)
  })

  it('does not mutate renderer state when creating the worktree fails', async () => {
    const failure = new Error('branch already exists')
    vi.mocked(window.electronAPI.gitWorktreeAdd).mockRejectedValueOnce(failure)

    await expect(actions.createWorktree('feature')).rejects.toBe(failure)

    expect(workspace().worktrees).toHaveLength(1)
    expect(workspace().additionalRoots).toBeUndefined()
    expect(h.refresh).not.toHaveBeenCalled()
  })

  it('rejects an empty sanitized name before invoking git', async () => {
    await expect(actions.createWorktree(' !!! ')).rejects.toThrow('Please enter a name')

    expect(window.electronAPI.gitWorktreeAdd).not.toHaveBeenCalled()
    expect(h.refresh).not.toHaveBeenCalled()
  })

  it('checks out a PR with a collision-resistant path and trusts the returned path', async () => {
    vi.mocked(window.electronAPI.gitWorktreeAddFromPr).mockResolvedValueOnce({
      path: '/runtime/repo/.cate/worktrees/pr-42-fork-feature',
      branch: 'fork-feature',
    })
    const pr = {
      number: 42,
      title: 'Feature',
      headRefName: 'fork/feature',
      author: 'contributor',
      isFork: true,
    }

    await act(async () => {
      await actions.checkoutPr(pr)
    })

    expect(window.electronAPI.gitWorktreeAddFromPr).toHaveBeenCalledWith(
      ROOT,
      42,
      '/repo/.cate/worktrees/pr-42-fork-feature',
      { symlinkPaths: ['node_modules', '.env.local'] },
      WS,
    )
    expect(workspace().worktrees).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'wt-test',
        path: '/runtime/repo/.cate/worktrees/pr-42-fork-feature',
        label: '#42 fork/feature',
        prNumber: 42,
      }),
    ]))
    expect(workspace().additionalRoots).toContain('/runtime/repo/.cate/worktrees/pr-42-fork-feature')
    expect(h.refresh).toHaveBeenCalledWith(ROOT)
  })
})
