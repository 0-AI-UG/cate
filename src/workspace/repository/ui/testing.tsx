// Test fakes for the repository views: a scriptable runtime in the runtime
// slot, a host for RepositoryUiProvider, and a React root to render into.

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { vi } from 'vitest'
import { setRuntimeResolver } from '@kernel/rpc/client'
import type { RuntimeProxy } from '@kernel/rpc/contract'
import { EMPTY_REPO_STATUS, type RepoStatus } from '../contract'
import { RepositoryUiProvider, type RepositoryUiHost } from './context'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Fn = ReturnType<typeof vi.fn>

/** A fake `vcs` whose `status` stream emits `statusFor(cwd)` on subscribe. */
export function fakeVcs(statusFor: (cwd: string) => Partial<RepoStatus> | null = () => null) {
  const status = vi.fn(({ cwd }: { cwd?: string }) => {
    const listeners = new Set<(s: RepoStatus) => void>()
    const snapshot = statusFor(cwd ?? '')
    return {
      onEvent(l: (s: RepoStatus) => void) {
        listeners.add(l)
        if (snapshot) queueMicrotask(() => l({ ...EMPTY_REPO_STATUS, isRepo: true, ...snapshot }))
        return () => listeners.delete(l)
      },
      done: new Promise(() => {}),
      cancel: vi.fn(),
    }
  })
  const resolved = (value: unknown) => vi.fn().mockResolvedValue(value)
  return {
    status,
    lsFiles: resolved([]),
    log: resolved([]),
    branchList: resolved({ current: 'main', branches: [] }),
    branchCreate: resolved(undefined),
    branchDelete: resolved(undefined),
    checkout: resolved(undefined),
    stage: resolved(undefined),
    unstage: resolved(undefined),
    discardFile: resolved(undefined),
    commit: resolved(undefined),
    push: resolved(undefined),
    pull: resolved({ summary: { changes: 0, insertions: 0, deletions: 0 } }),
    fetch: resolved(undefined),
    stash: resolved(undefined),
    stashPop: resolved(undefined),
    init: resolved(undefined),
    prList: resolved([]),
    findRepos: resolved([]),
    remotes: resolved([]),
    worktreeCreate: vi.fn(),
    worktreeRemove: resolved({}),
    worktreePrune: resolved({ output: '', removed: [] }),
    worktreeStatus: resolved(null),
    worktreeUpdateFrom: resolved({ ok: true, result: null }),
    worktreeMergeTo: resolved({ ok: true, result: null }),
    createPr: resolved({ ok: true, created: true, url: 'https://github.com/o/r/pull/1' }),
    prStatus: resolved(null),
    prContext: resolved(null),
    githubConnection: resolved({ status: 'connected', account: 'alice' }),
    githubLogin: resolved({ status: 'idle' }),
    pullRequests: resolved({ status: 'ready', account: 'alice', items: [], truncated: false }),
  } satisfies Record<string, Fn>
}

export type FakeVcs = ReturnType<typeof fakeVcs>

/** Installs a runtime for every workspace id; returns it and the uninstall. */
export function installFakeRuntime(vcs: FakeVcs = fakeVcs(), file: Record<string, Fn> = { stat: vi.fn().mockResolvedValue({}) }) {
  const runtime = { vcs, file } as unknown as RuntimeProxy
  const uninstall = setRuntimeResolver(() => runtime)
  return { runtime, vcs, file, uninstall }
}

export function fakeHost(patch: Partial<RepositoryUiHost> = {}): RepositoryUiHost {
  return {
    workspaceId: 'ws',
    root: '/repo',
    worktrees: [],
    panels: [],
    launchTypes: [{ type: 'terminal', label: 'Terminal', icon: 'terminal' }, { type: 'chat', label: 'T3 Code', icon: 't3' }],
    setWorktree: vi.fn(),
    launchInWorktree: vi.fn().mockResolvedValue(true),
    worktreePanelSummary: vi.fn(() => ({ count: 0, hasDirtyEditor: false })),
    prepareWorktreeClose: vi.fn().mockResolvedValue(true),
    bindsWorktree: (panel) => panel.type === 'terminal' || panel.type === 'chat',
    switchPanelWorktree: vi.fn().mockResolvedValue(undefined),
    openReview: vi.fn().mockResolvedValue(undefined),
    focusedWorktreeId: null,
    focusWorktree: vi.fn(),
    setHoveredWorktree: vi.fn(),
    ...patch,
  }
}

export interface Mounted {
  host: HTMLDivElement
  render(node: ReactNode, repoHost?: RepositoryUiHost): Promise<void>
  unmount(): void
  button(text: string): HTMLButtonElement
}

export function mount(): Mounted {
  const host = document.createElement('div')
  document.body.append(host)
  const root: Root = createRoot(host)
  let lastHost: RepositoryUiHost | undefined
  return {
    host,
    async render(node, repoHost) {
      lastHost = repoHost ?? lastHost
      await act(async () => {
        root.render(lastHost ? <RepositoryUiProvider host={lastHost}>{node}</RepositoryUiProvider> : node)
      })
      await act(async () => { await Promise.resolve() })
    },
    unmount() {
      act(() => root.unmount())
      host.remove()
    },
    button(text) {
      const found = [...host.querySelectorAll('button')].find((b) => b.textContent === text)
      if (!found) throw new Error(`No button "${text}"`)
      return found
    },
  }
}
