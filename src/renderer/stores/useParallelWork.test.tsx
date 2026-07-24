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
  return { refresh: vi.fn() }
})

vi.mock('./gitStatusStore', () => ({
  gitStatusStore: { refresh: h.refresh },
}))

vi.mock('./useWorktreeActions', () => ({
  useWorktreeActions: () => ({
    createWorktree: vi.fn(),
    checkoutPr: vi.fn(),
  }),
}))

import { useAppStore } from './appStore'
import { useSettingsStore } from './settingsStore'
import {
  runWorktreeContextMenu,
  useParallelWork,
  type UseParallelWork,
  type WorktreeStatus,
} from './useParallelWork'
import type { JoinedWorktree } from './useWorktrees'

const ROOT = '/repo'
const WS = 'ws-1'
const worktree: JoinedWorktree = {
  id: 'wt-feature',
  path: '/repo/.cate/worktrees/feature',
  branch: 'feature',
  label: 'Feature',
  color: '#abcdef',
  isPrimary: false,
  isCurrent: false,
  isOrphan: false,
}

let host: HTMLDivElement
let root: Root
let actions: UseParallelWork
let setError: ReturnType<typeof vi.fn<(value: string | null) => void>>
let setBusy: ReturnType<typeof vi.fn<(value: string | null) => void>>
const initialAppState = useAppStore.getState()
const initialSettingsState = useSettingsStore.getState()

function Probe(): React.ReactElement {
  actions = useParallelWork(ROOT, WS, 'main', { setError, setBusy })
  return <div />
}

function workspace() {
  return useAppStore.getState().workspaces.find((ws) => ws.id === WS)!
}

function status(overrides: Partial<WorktreeStatus> = {}): WorktreeStatus {
  return {
    branch: 'feature',
    dirty: false,
    ahead: 0,
    behind: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    ...overrides,
  }
}

beforeEach(() => {
  h.refresh.mockReset()
  setError = vi.fn()
  setBusy = vi.fn()
  useSettingsStore.setState({
    ...initialSettingsState,
    closeWorktreePanelsOnDelete: true,
  }, true)
  useAppStore.setState({
    ...initialAppState,
    workspaces: [{
      id: WS,
      name: 'Repo',
      color: '',
      rootPath: ROOT,
      worktrees: [
        { id: 'primary', path: ROOT, color: '#112233' },
        { id: worktree.id, path: worktree.path, color: '#abcdef' },
      ],
      panels: {},
    }],
    selectedWorkspaceId: WS,
  }, true)
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    gitPush: vi.fn().mockResolvedValue(undefined),
    gitCreatePR: vi.fn(),
    gitWorktreeStatus: vi.fn().mockResolvedValue(status()),
    gitWorktreeRemove: vi.fn().mockResolvedValue(undefined),
    gitBranchDelete: vi.fn().mockResolvedValue(undefined),
    gitWorktreePrune: vi.fn().mockResolvedValue({ output: '' }),
    gitWorktreeList: vi.fn().mockResolvedValue([
      { path: ROOT, branch: 'main', isBare: false, isCurrent: true },
    ]),
    shellShowInFolder: vi.fn().mockResolvedValue(undefined),
    showContextMenu: vi.fn().mockResolvedValue(null),
  }
  vi.spyOn(window, 'confirm').mockReturnValue(true)
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

describe('useParallelWork handleDelete', () => {
  it('uses fresh dirty status for confirmation and force-removes disk and store state', async () => {
    vi.mocked(window.electronAPI.gitWorktreeStatus).mockResolvedValueOnce(status({ dirty: true, ahead: 2 }))

    await act(async () => {
      await actions.handleDelete(worktree)
    })

    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('unsaved changes here will be lost'))
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('2 unpublished commit(s) will be lost'))
    expect(window.electronAPI.gitWorktreeRemove).toHaveBeenCalledWith(
      ROOT,
      worktree.path,
      { force: true },
      WS,
    )
    expect(window.electronAPI.gitBranchDelete).toHaveBeenCalledWith(ROOT, 'feature', true, WS)
    expect(workspace().worktrees?.some((wt) => wt.id === worktree.id)).toBe(false)
    expect(h.refresh).toHaveBeenCalledWith(ROOT)
    expect(setBusy.mock.calls).toEqual([[worktree.id], [null]])
  })

  it('preserves renderer state and reports the error when disk removal fails', async () => {
    vi.mocked(window.electronAPI.gitWorktreeRemove).mockRejectedValueOnce(new Error('worktree locked'))

    await act(async () => {
      await actions.handleDelete(worktree)
    })

    expect(workspace().worktrees?.some((wt) => wt.id === worktree.id)).toBe(true)
    expect(window.electronAPI.gitBranchDelete).not.toHaveBeenCalled()
    expect(h.refresh).not.toHaveBeenCalled()
    expect(setError).toHaveBeenCalledWith('Discard failed: worktree locked')
    expect(setBusy.mock.calls).toEqual([[worktree.id], [null]])
  })

  it('finishes store removal but reports a partial failure when branch deletion fails', async () => {
    vi.mocked(window.electronAPI.gitBranchDelete).mockRejectedValueOnce(new Error('branch protected'))

    await act(async () => {
      await actions.handleDelete(worktree)
    })

    expect(workspace().worktrees?.some((wt) => wt.id === worktree.id)).toBe(false)
    expect(setError).toHaveBeenCalledWith('Removed, but branch feature could not be deleted: branch protected')
    expect(h.refresh).toHaveBeenCalledWith(ROOT)
  })

  it('does not remove anything when the user cancels', async () => {
    vi.mocked(window.confirm).mockReturnValueOnce(false)

    await act(async () => {
      await actions.handleDelete(worktree)
    })

    expect(window.electronAPI.gitWorktreeRemove).not.toHaveBeenCalled()
    expect(workspace().worktrees?.some((wt) => wt.id === worktree.id)).toBe(true)
    expect(setBusy).not.toHaveBeenCalled()
  })

  it('does not offer a destructive confirmation when status cannot be verified', async () => {
    vi.mocked(window.electronAPI.gitWorktreeStatus).mockRejectedValueOnce(
      new Error(`Error invoking remote method 'git:worktreeStatus': Error: runtime disconnected`),
    )

    await act(async () => {
      await actions.handleDelete(worktree)
    })

    expect(window.confirm).not.toHaveBeenCalled()
    expect(window.electronAPI.gitWorktreeRemove).not.toHaveBeenCalled()
    expect(setError).toHaveBeenCalledWith(
      'Couldn’t verify this worktree before discarding it: runtime disconnected',
    )
  })
})

describe('useParallelWork failure handling', () => {
  it('strips IPC and raw push noise from publish errors', async () => {
    vi.mocked(window.electronAPI.gitPush).mockRejectedValueOnce(
      new Error(
        `Error invoking remote method 'git:push': Error: ` +
        `To github.com:owner/repo.git\n ! [rejected] feature -> feature (non-fast-forward)\n` +
        `error: failed to push some refs`,
      ),
    )

    await act(async () => {
      await actions.handlePublish(worktree)
    })

    expect(setError).toHaveBeenCalledWith(
      'Publish failed: The remote branch has newer commits. Update this worktree, then try publishing again.',
    )
  })

  it('does not remove saved entries when cleanup cannot verify the primary worktree', async () => {
    vi.mocked(window.electronAPI.gitWorktreeList).mockResolvedValueOnce([])

    await act(async () => {
      await actions.handlePrune()
    })

    expect(workspace().worktrees?.some((wt) => wt.id === worktree.id)).toBe(true)
    expect(setError).toHaveBeenCalledWith(
      'Couldn’t verify the live worktrees after cleanup. No saved entries were removed.',
    )
  })

  it('does not create a duplicate PR when an existing PR temporarily cannot be loaded', () => {
    actions.makeCallbacks({ ...worktree, prNumber: 525 }).onOpenPr(undefined)

    expect(setError).toHaveBeenCalledWith(
      'Couldn’t load PR #525. Check your GitHub connection and try again.',
    )
  })

  it('refuses direct PR creation for a worktree that already belongs to a PR', async () => {
    await act(async () => {
      await actions.handleCreatePR({ ...worktree, prNumber: 525 })
    })

    expect(window.electronAPI.gitCreatePR).not.toHaveBeenCalled()
    expect(setError).toHaveBeenCalledWith(
      'This worktree already belongs to PR #525. Open that pull request instead.',
    )
  })

  it('reports native menu and reveal failures through the popup error channel', async () => {
    const callbacks = actions.makeCallbacks(worktree)
    vi.mocked(window.electronAPI.showContextMenu).mockRejectedValueOnce(
      new Error(`Error invoking remote method 'menu:showContext': Error: menu unavailable`),
    )

    await runWorktreeContextMenu({
      isPrimary: false,
      hasPr: false,
      primaryLabel: 'main',
      cb: callbacks,
      beginRename: vi.fn(),
      beginRecolor: vi.fn(),
    })

    expect(setError).toHaveBeenCalledWith('Couldn’t open worktree actions: menu unavailable')

    vi.mocked(window.electronAPI.shellShowInFolder).mockRejectedValueOnce(
      new Error(`Error invoking remote method 'shell:showInFolder': Error: folder missing`),
    )
    callbacks.onReveal()
    await vi.waitFor(() => {
      expect(setError).toHaveBeenCalledWith('Couldn’t reveal this worktree: folder missing')
    })
  })
})
