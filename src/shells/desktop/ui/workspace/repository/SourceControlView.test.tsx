import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installMockClientUi } from '../../../../../test/clientUi'
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
  rt.vcs.compare.mockResolvedValue({ spec: { kind: 'uncommitted' }, files: [{ path: 'partial.ts', status: 'modified', working: true, staged: true, additions: 1, deletions: 1, binary: false }], additions: 1, deletions: 1 })
  ui = installMockClientUi()
  resetSourceControlViewState({ drafts: { '/repo': 'main draft', '/repo/feature': 'feature draft' } })
  m = mount()
})
afterEach(() => { m.unmount(); rt.uninstall() })

it('scopes files and drafts to Changes while history remains on the repository root', async () => {
  await m.render(<SourceControlView rootPath="/repo" />, fakeHost({ worktrees: meta }))
  expect(m.host.querySelector('textarea')!.value).toBe('main draft')
  await act(async () => m.host.querySelector<HTMLButtonElement>('[aria-label="Changes worktree: feature"]')!.click())
  await act(async () => { await Promise.resolve() })
  expect(m.host.querySelector('textarea')!.value).toBe('feature draft')
  expect(rt.vcs.log).toHaveBeenLastCalledWith({ cwd: '/repo', maxCount: 30 })
  // A partially staged file still exposes its remaining unstaged changes.
  await act(async () => m.host.querySelector<HTMLButtonElement>('[aria-label="Stage partial.ts"]')!.click())
  expect(rt.vcs.stage).toHaveBeenCalledWith({ cwd: '/repo/feature', path: 'partial.ts' })
  await act(async () => m.button('History').click())
  expect(m.host.querySelector('[aria-label="Changes worktree: feature"]')).toBeNull()
  expect(m.host.querySelector('textarea')).toBeNull()
})

it('expands changes in the initial view alongside the commit composer', async () => {
  const host = fakeHost({ worktrees: meta })
  await m.render(<SourceControlView rootPath="/repo" />, host)
  expect(rt.vcs.compare).toHaveBeenCalledWith({ cwd: '/repo', spec: { kind: 'uncommitted', ignoreWhitespace: false } })
  expect(rt.vcs.fileDiff).not.toHaveBeenCalled()
  await act(async () => m.host.querySelector<HTMLButtonElement>('[aria-label="Expand partial.ts"]')!.click())
  expect(rt.vcs.fileDiff).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/repo', path: 'partial.ts' }))
  expect(host.openReview).not.toHaveBeenCalled()
  expect(m.host.textContent).not.toContain('Back to source control')
  expect(m.host.querySelector('textarea')!.value).toBe('main draft')
  expect(m.host.querySelector('[aria-label="Stage partial.ts"]')).not.toBeNull()
  expect(m.host.querySelector('[aria-label="Unstage partial.ts"]')).not.toBeNull()
  expect(m.host.querySelector('select, input[type="checkbox"]')).toBeNull()
  expect(ui.showContextMenu).not.toHaveBeenCalled()
})

it('keeps the composer and navigation available when inspecting a commit', async () => {
  rt.vcs.log.mockResolvedValue([{ hash: 'abc1234', message: 'Fix login', author_name: 'Anton', date: new Date().toISOString() }])
  await m.render(<SourceControlView rootPath="/repo" />, fakeHost({ worktrees: meta }))
  await act(async () => m.button('History').click())
  await act(async () => [...m.host.querySelectorAll<HTMLElement>('div')].find(el => el.textContent === 'Fix login')!.click())
  expect(rt.vcs.compare).toHaveBeenLastCalledWith({ cwd: '/repo', spec: { kind: 'commit', commit: 'abc1234', ignoreWhitespace: false } })
  expect(m.host.querySelector('textarea')!.value).toBe('main draft')
  expect(m.host.querySelector('[aria-label="Repository sections"]')).not.toBeNull()
  await act(async () => m.button('Working changes').click())
  expect(m.host.textContent).not.toContain('Commit abc1234')
  expect(m.host.querySelector('textarea')!.value).toBe('main draft')
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


it('does not claim zero changes or Detached HEAD before the first Git status', async () => {
  rt.uninstall()
  let finish!: (status: { branch: string; files: { path: string; index: string; working_dir: string }[] }) => void
  rt = installFakeRuntime(fakeVcs(() => new Promise((resolve) => { finish = resolve })))
  await m.render(<SourceControlView rootPath="/repo" />, fakeHost())
  expect(m.host.textContent).toContain('Loading Git status')
  expect(m.host.textContent).not.toContain('0 files changed')
  expect(m.host.textContent).not.toContain('Detached HEAD')
  await act(async () => finish({ branch: 'main', files: [{ path: 'changed.ts', index: 'M', working_dir: ' ' }] }))
  expect(m.host.textContent).toContain('1 file changed')
})

it('waits for history and branch responses before displaying counts or empty states', async () => {
  let finish!: (entries: []) => void
  rt.vcs.log.mockReturnValue(new Promise((resolve) => { finish = resolve }))
  rt.vcs.branchList.mockReturnValue(new Promise(() => {}))
  await m.render(<SourceControlView rootPath="/repo" />, fakeHost())
  await act(async () => m.button('History').click())
  expect(m.host.textContent).toContain('Loading commits')
  expect(m.host.textContent).not.toContain('No commits to display')
  await act(async () => finish([]))
  expect(m.host.textContent).toContain('No commits to display')
  await act(async () => m.button('Branches').click())
  expect(m.host.textContent).toContain('Loading branches')
})
