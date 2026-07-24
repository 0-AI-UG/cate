import React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JoinedWorktree } from './useWorktrees'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('./gitStatusStore', () => ({
  workspaceIdForRoot: () => 'ws-1',
}))

import { useWorktreeStatuses } from './useWorktreeStatuses'

const worktree: JoinedWorktree = {
  id: 'wt-pr',
  path: '/repo/.cate/worktrees/pr-525',
  branch: 'cate-pr-525',
  prNumber: 525,
  isPrimary: false,
  isCurrent: false,
  isOrphan: false,
}

let host: HTMLDivElement
let root: Root

function Probe(): React.ReactElement {
  useWorktreeStatuses('/repo', [worktree])
  return <div />
}

beforeEach(() => {
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    gitWorktreeStatus: vi.fn().mockResolvedValue(null),
    gitPrStatus: vi.fn().mockResolvedValue(null),
  }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('useWorktreeStatuses', () => {
  it('looks up an isolated checkout by its persisted PR number', async () => {
    act(() => root.render(<Probe />))
    await act(async () => {
      await vi.waitFor(() => {
        expect(window.electronAPI.gitPrStatus).toHaveBeenCalled()
      })
    })

    expect(window.electronAPI.gitPrStatus).toHaveBeenCalledWith(
      worktree.path,
      '525',
      'ws-1',
    )
  })
})
