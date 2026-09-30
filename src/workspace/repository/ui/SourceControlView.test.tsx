import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installMockClientUi } from '@kernel/ui/testing'
import { SourceControlView, resetSourceControlViewState } from './SourceControlView'
import { fakeHost, fakeVcs, installFakeRuntime, mount, type Mounted } from './testing'

const worktrees = [
  { path: '/repo', branch: 'main', isBare: false, isCurrent: true },
  { path: '/repo/feature', branch: 'feature', isBare: false, isCurrent: false },
]
let m: Mounted
let rt: ReturnType<typeof installFakeRuntime>
let ui: ReturnType<typeof installMockClientUi>
const meta = [
  { id: 'main', path: '/repo', color: 'green', status: 'ready' as const },
  { id: 'feature', path: '/repo/feature', color: 'cyan', status: 'ready' as const },
]

beforeEach(() => {
  rt = installFakeRuntime(fakeVcs((cwd) => ({
    branch: cwd === '/repo' ? 'main' : 'feature',
    files: [{ path: 'partial.ts', index: 'M', working_dir: 'M' }],
    worktrees,
  })))
  ui = installMockClientUi({ showContextMenu: vi.fn().mockResolvedValue('feature') })
  resetSourceControlViewState({ drafts: { '/repo': 'main draft', '/repo/feature': 'feature draft' } })
  m = mount()
})
afterEach(() => { m.unmount(); rt.uninstall() })

it('scopes files and drafts to Changes while history remains on the repository root', async () => {
  await m.render(<SourceControlView rootPath="/repo" />, fakeHost({ worktrees: meta }))
  expect(m.host.querySelector('textarea')!.value).toBe('main draft')
  await act(async () => m.host.querySelector<HTMLButtonElement>('[aria-label^="Changes worktree"]')!.click())
  await act(async () => { await Promise.resolve() })
  expect(m.host.querySelector('textarea')!.value).toBe('feature draft')
  expect(rt.vcs.log).toHaveBeenLastCalledWith({ cwd: '/repo', maxCount: 30 })
  // A partially staged file still exposes its remaining unstaged changes.
  await act(async () => m.host.querySelector<HTMLButtonElement>('[aria-label="Stage file"]')!.click())
  expect(rt.vcs.stage).toHaveBeenCalledWith({ cwd: '/repo/feature', path: 'partial.ts' })
  await act(async () => m.button('History').click())
  expect(m.host.querySelector('[aria-label^="Changes worktree"]')).toBeNull()
  expect(m.host.querySelector('textarea')).toBeNull()
})

it('review buttons ask the client to open a review', async () => {
  const host = fakeHost({ worktrees: meta })
  await m.render(<SourceControlView rootPath="/repo" />, host)
  await act(async () => m.host.querySelector<HTMLButtonElement>('[aria-label="Review staged changes"]')!.click())
  expect(host.openReview).toHaveBeenCalledWith({ repoPath: '/repo', spec: { kind: 'staged' }, focusedFile: undefined, openNew: false })
})

it('cleans merged local branches with safe deletes while preserving the current branch', async () => {
  ui.confirm.mockResolvedValue(true)
  rt.vcs.branchList.mockResolvedValue({
    current: 'main',
    branches: [
      { name: 'main', current: true, commit: 'a', label: '', isRemote: false },
      { name: 'merged-one', current: false, commit: 'b', label: '', isRemote: false },
      { name: 'merged-two', current: false, commit: 'c', label: '', isRemote: false },
      { name: 'remotes/origin/main', current: false, commit: 'a', label: '', isRemote: true },
    ],
  })
  await m.render(<SourceControlView rootPath="/repo" />, fakeHost({ worktrees: meta }))
  await act(async () => m.button('Branches').click())
  await act(async () => m.host.querySelector<HTMLButtonElement>('[aria-label="Delete merged local branches"]')!.click())
  expect(rt.vcs.branchDelete).toHaveBeenCalledTimes(2)
  expect(rt.vcs.branchDelete).toHaveBeenCalledWith({ cwd: '/repo', name: 'merged-one' })
  expect(rt.vcs.branchDelete).toHaveBeenCalledWith({ cwd: '/repo', name: 'merged-two' })
})
