import { beforeEach, expect, it, vi } from 'vitest'
import type { RuntimeProxy } from '@kernel/rpc/contract'
import type { PullRequestItem } from '@workspace/repository/contract'
import { openPullRequest } from './flows'
import type { RepositoryHost } from './host'

const fakeVcs = () => ({ prContext: vi.fn(), worktreeCreate: vi.fn() })
const fakeHost = (patch: Partial<RepositoryHost> = {}) => ({
  worktrees: [],
  panels: [],
  launchTypes: [{ type: 'terminal', label: 'Terminal', icon: 'terminal', switches: true }, { type: 'chat', label: 'T3 Code', icon: 't3', switches: true }],
  launchInWorktree: vi.fn().mockResolvedValue(true),
  openReview: vi.fn().mockResolvedValue(undefined),
  ...patch,
}) as Pick<RepositoryHost, 'worktrees' | 'panels' | 'launchTypes' | 'launchInWorktree' | 'openReview'>

const pr = { number: 42, title: 'Fix startup', repository: 'org/repo', author: 'alice' } as PullRequestItem
let vcs: ReturnType<typeof fakeVcs>
beforeEach(() => {
  vcs = fakeVcs()
  vcs.prContext.mockResolvedValue({ headRefName: 'fix', baseOid: 'a'.repeat(40) })
  vcs.worktreeCreate.mockResolvedValue({ id: 'wt', path: '/repo/.cate/worktrees/pr-42-fix', color: 'green', status: 'ready' })
})
const runtime = () => ({ vcs }) as unknown as RuntimeProxy

it('checks out the PR, opens a terminal and a chat there, and reviews it', async () => {
  const host = fakeHost()
  expect(await openPullRequest(pr, host, runtime())).toBe(true)
  expect(vcs.worktreeCreate).toHaveBeenCalledWith({ branch: 'fix', fromPr: 42, label: '#42 fix' })
  const wt = { id: 'wt', path: '/repo/.cate/worktrees/pr-42-fix', color: 'green', status: 'ready' }
  expect(host.launchInWorktree).toHaveBeenCalledWith(wt, 'terminal')
  expect(host.launchInWorktree).toHaveBeenCalledWith(wt, 'chat')
  expect(host.openReview).toHaveBeenCalledWith({
    repoPath: '/repo/.cate/worktrees/pr-42-fix',
    spec: { kind: 'branch', base: 'a'.repeat(40), target: 'HEAD' },
    title: '#42 Fix startup',
  })
})

it('reopens an existing PR without duplicating its worktree or panels', async () => {
  const host = fakeHost({
    worktrees: [{ id: 'wt', path: '/wt', prNumber: 42, color: 'green', status: 'ready' }],
    panels: [
      { id: 't', type: 'terminal', title: 'T', worktreeId: 'wt', fields: {} },
      { id: 'c', type: 'chat', title: 'C', worktreeId: 'wt', fields: {} },
    ],
  })
  await openPullRequest(pr, host, runtime())
  expect(vcs.worktreeCreate).not.toHaveBeenCalled()
  expect(host.launchInWorktree).not.toHaveBeenCalled()
  expect(host.openReview).toHaveBeenCalled()
})

it('stops when the person cancels a panel placement', async () => {
  const host = fakeHost({ launchInWorktree: vi.fn().mockResolvedValue(false) })
  await openPullRequest(pr, host, runtime())
  expect(host.launchInWorktree).toHaveBeenCalledTimes(1)
  expect(host.openReview).not.toHaveBeenCalled()
})

it('resolves false when the workspace is not the PR repository', async () => {
  vcs.prContext.mockResolvedValue(null)
  const host = fakeHost()
  expect(await openPullRequest(pr, host, runtime())).toBe(false)
  expect(vcs.worktreeCreate).not.toHaveBeenCalled()
})
