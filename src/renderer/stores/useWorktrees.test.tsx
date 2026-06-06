// =============================================================================
// Render tests for useWorktrees — the read-time join of the live git worktree
// list (gitStatusStore) with the UI-owned metadata persisted in appStore.
//
// useWorktrees builds a fresh array, so it MUST be memoized on its inputs or it
// would feed a new reference into every consumer render. These tests assert the
// join is correct (live facts win, metadata joins, orphans surface) AND that the
// returned array is reference-stable across unrelated re-renders.
//
// Clean exit: gitStatusStore is fully mocked (no fs watcher / timer / focus
// listener), appStore is reset, and every React root is unmounted in afterEach.
// =============================================================================

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { GitStatusSnapshot } from './gitStatusStore'

// A controllable snapshot fed to the hook in place of the real store loop.
let snapshot: GitStatusSnapshot = {
  isRepo: true,
  tracked: new Set(),
  statusFiles: [],
  branch: 'main',
  ahead: 0,
  behind: 0,
  worktrees: [],
  revision: 1,
}

vi.mock('./gitStatusStore', () => ({
  useGitStatusSnapshot: () => snapshot,
}))

import { useWorktrees, type JoinedWorktree } from './useWorktrees'
import { useAppStore } from './appStore'

const WS = 'ws-1'
const ROOT = '/repo'

function setWorkspace(worktrees: Array<{ id: string; path: string; color?: string; label?: string }>) {
  useAppStore.setState({
    workspaces: [{ id: WS, rootPath: ROOT, worktrees } as any],
  } as any)
}

const roots: Root[] = []
let lastResult: JoinedWorktree[] = []
let renderCount = 0

function Probe({ tick }: { tick: number }): React.ReactElement {
  renderCount++
  lastResult = useWorktrees(ROOT, WS)
  return <div data-tick={tick} />
}

function mount(): Root {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  roots.push(root)
  act(() => {
    root.render(<Probe tick={0} />)
  })
  return root
}

beforeEach(() => {
  renderCount = 0
  lastResult = []
  ;(window as any).electronAPI = {}
  snapshot = {
    isRepo: true,
    tracked: new Set(),
    statusFiles: [],
    branch: 'main',
    ahead: 0,
    behind: 0,
    worktrees: [
      { path: '/repo', branch: 'main', isPrimary: true, isCurrent: true },
      { path: '/repo/.cate/worktrees/feat', branch: 'feat', isPrimary: false, isCurrent: false },
    ],
    revision: 1,
  }
})

afterEach(() => {
  act(() => {
    for (const r of roots) r.unmount()
  })
  roots.length = 0
  document.body.innerHTML = ''
  useAppStore.setState({ workspaces: [] } as any)
  vi.restoreAllMocks()
})

describe('useWorktrees', () => {
  it('joins live git facts with persisted UI metadata and mounts without a loop', () => {
    setWorkspace([
      { id: 'meta-feat', path: '/repo/.cate/worktrees/feat', color: '#f00', label: 'Feature' },
    ])
    mount()
    expect(renderCount).toBeLessThanOrEqual(2)

    const byPath = Object.fromEntries(lastResult.map((w) => [w.path, w]))
    expect(byPath['/repo'].isPrimary).toBe(true)
    expect(byPath['/repo'].isCurrent).toBe(true)
    // Live branch wins; UI metadata (id/color/label) joins on by path.
    const feat = byPath['/repo/.cate/worktrees/feat']
    expect(feat.branch).toBe('feat')
    expect(feat.id).toBe('meta-feat')
    expect(feat.color).toBe('#f00')
    expect(feat.label).toBe('Feature')
    expect(feat.isOrphan).toBe(false)
  })

  it('surfaces persisted metadata with no live worktree as an orphan', () => {
    setWorkspace([
      { id: 'meta-gone', path: '/repo/.cate/worktrees/gone', label: 'Gone' },
    ])
    mount()
    const orphan = lastResult.find((w) => w.path === '/repo/.cate/worktrees/gone')
    expect(orphan?.isOrphan).toBe(true)
    expect(orphan?.label).toBe('Gone')
    // The primary path is never an orphan even without persisted metadata.
    expect(lastResult.find((w) => w.path === '/repo')?.isOrphan).toBe(false)
  })

  it('returns a stable array reference across unrelated re-renders', () => {
    setWorkspace([])
    const root = mount()
    const first = lastResult
    act(() => {
      root.render(<Probe tick={1} />)
    })
    act(() => {
      root.render(<Probe tick={2} />)
    })
    // Same snapshot + same meta -> memoized to the same array.
    expect(lastResult).toBe(first)
  })
})
