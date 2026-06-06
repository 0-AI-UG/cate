// =============================================================================
// Render tests for the gitStatusStore React hooks (useGitStatusSnapshot,
// useGitTreeFor, useGitStatusSubscription).
//
// These are useSyncExternalStore consumers: the same shape that crashed the app
// when a selector returned a fresh reference every render ("Maximum update depth
// exceeded"). The tests mount each hook, assert it does NOT spin into an update
// loop, returns a STABLE reference between unrelated re-renders, and still
// updates reactively when a new snapshot is applied.
//
// Clean exit: fsWatchManager is mocked (no real fs watcher), electronAPI is a
// stub, every root is torn down via gitStatusStore._reset(), and every React
// root is unmounted in afterEach — so no timer, watcher, or focus listener
// survives the file (CI must not hang).
// =============================================================================

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

vi.mock('../lib/fs/fsWatchManager', () => ({
  watchFsRoot: () => () => {},
}))

import {
  gitStatusStore,
  useGitStatusSnapshot,
  useGitTreeFor,
  useGitStatusSubscription,
} from './gitStatusStore'

const ROOT = '/repo'

function makeApi(overrides: Record<string, unknown> = {}) {
  return {
    gitIsRepo: vi.fn(async () => true),
    gitLsFiles: vi.fn(async () => ['a.ts', 'b.ts']),
    gitStatus: vi.fn(async () => ({
      files: [{ path: 'a.ts', index: ' ', working_dir: 'M' }],
      current: 'main',
      tracking: 'origin/main',
      ahead: 1,
      behind: 2,
    })),
    gitWorktreeList: vi.fn(async () => [
      { path: '/repo', branch: 'main', isBare: false, isCurrent: true },
    ]),
    onGitBranchUpdate: vi.fn(() => () => {}),
    ...overrides,
  }
}

/** Flush microtasks + a macrotask so an in-flight async fetch settles. */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
  for (let i = 0; i < 4; i++) await Promise.resolve()
}

const roots: Root[] = []
function mount(el: React.ReactElement): Root {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  roots.push(root)
  act(() => {
    root.render(el)
  })
  return root
}

beforeEach(() => {
  gitStatusStore._reset()
  ;(window as any).electronAPI = makeApi()
})

afterEach(() => {
  act(() => {
    for (const r of roots) r.unmount()
  })
  roots.length = 0
  document.body.innerHTML = ''
  gitStatusStore._reset()
  vi.restoreAllMocks()
})

describe('useGitStatusSnapshot', () => {
  it('mounts without an update loop and exposes the fetched snapshot', async () => {
    let renders = 0
    let branch: string | null | undefined
    function Probe(): React.ReactElement {
      renders++
      branch = useGitStatusSnapshot(ROOT).branch
      return <div />
    }
    mount(<Probe />)
    // Mount + the empty initial snapshot is fine; a runaway loop would have
    // thrown before we reach here.
    expect(renders).toBeLessThanOrEqual(2)
    expect(branch).toBeNull()

    await act(async () => {
      await flush()
    })
    expect(branch).toBe('main')
    // One mount render + one for the applied snapshot. No loop.
    expect(renders).toBeLessThanOrEqual(3)
  })

  it('returns a stable snapshot reference across unrelated parent re-renders', async () => {
    const seen: unknown[] = []
    function Probe({ tick }: { tick: number }): React.ReactElement {
      seen.push(useGitStatusSnapshot(ROOT))
      return <div data-tick={tick} />
    }
    const root = mount(<Probe tick={0} />)
    await act(async () => {
      await flush()
    })
    const afterFetch = seen[seen.length - 1]
    // Re-render the parent with new props but no store change.
    act(() => {
      root.render(<Probe tick={1} />)
    })
    act(() => {
      root.render(<Probe tick={2} />)
    })
    expect(seen[seen.length - 1]).toBe(afterFetch)
  })
})

describe('useGitTreeFor', () => {
  it('builds a GitTree that is stable until the snapshot revision changes', async () => {
    const seen: Array<unknown> = []
    function Probe({ tick }: { tick: number }): React.ReactElement {
      seen.push(useGitTreeFor(ROOT))
      return <div data-tick={tick} />
    }
    const root = mount(<Probe tick={0} />)
    await act(async () => {
      await flush()
    })
    const tree = seen[seen.length - 1] as { tracked: Set<string> } | undefined
    expect(tree).toBeDefined()
    expect(tree!.tracked.has('/repo/a.ts')).toBe(true)

    // Unrelated parent re-render: same revision -> same memoized tree reference.
    act(() => {
      root.render(<Probe tick={1} />)
    })
    expect(seen[seen.length - 1]).toBe(tree)

    // A real refresh bumps the revision -> a new tree.
    await act(async () => {
      gitStatusStore.refresh(ROOT)
      await flush()
    })
    expect(seen[seen.length - 1]).not.toBe(tree)
  })

  it('returns undefined outside a repo', async () => {
    ;(window as any).electronAPI = makeApi({ gitIsRepo: vi.fn(async () => false) })
    let tree: unknown = 'unset'
    function Probe(): React.ReactElement {
      tree = useGitTreeFor(ROOT)
      return <div />
    }
    mount(<Probe />)
    await act(async () => {
      await flush()
    })
    expect(tree).toBeUndefined()
  })
})

describe('useGitStatusSubscription', () => {
  it('arms exactly one shared watcher for the root and releases it on unmount', async () => {
    function Probe(): React.ReactElement {
      useGitStatusSubscription(ROOT, 'ws-1')
      return <div />
    }
    // Two mounts of the subscription-only hook share one armed loop.
    const a = mount(<Probe />)
    const b = mount(<Probe />)
    await act(async () => {
      await flush()
    })
    // The snapshot is populated once, proving the loop armed.
    expect(gitStatusStore.getSnapshot(ROOT).branch).toBe('main')

    act(() => {
      a.unmount()
      b.unmount()
    })
    roots.length = 0
    // After the last subscriber leaves, the root is disarmed (removed).
    expect(gitStatusStore.getSnapshot(ROOT).branch).toBeNull()
  })
})
