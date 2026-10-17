import { afterEach, beforeEach, expect, it } from 'vitest'
import type { JoinedWorktree } from '@workspace/repository/contract'
import type { GitStatusSnapshot } from '@workspace/repository/client'
import { useGitStatus } from './gitStatus'
import { useWorktrees } from './worktrees'
import { fakeHost, fakeVcs, installFakeRuntime, mount, type Mounted } from './testing'

let m: Mounted
let rt: ReturnType<typeof installFakeRuntime>
beforeEach(() => {
  rt = installFakeRuntime(fakeVcs((cwd) => (cwd === '/repo' ? {
    branch: 'main',
    worktrees: [
      { path: '/repo', branch: 'main', isBare: false, isCurrent: true },
      { path: '/repo/.cate/worktrees/a', branch: 'a', isBare: false, isCurrent: false },
    ],
  } : null)))
  m = mount()
})
afterEach(() => { m.unmount(); rt.uninstall() })

it('joins live checkouts with metadata and lists orphans', async () => {
  let seen: JoinedWorktree[] = []
  function Probe() { seen = useWorktrees(); return null }
  await m.render(<Probe />, fakeHost({ worktrees: [
    { id: 'a', path: '/repo/.cate/worktrees/a', color: 'cyan', label: 'Feature A', status: 'ready' },
    { id: 'gone', path: '/repo/.cate/worktrees/gone', color: 'red', status: 'ready' },
  ] }))
  expect(seen.map((w) => [w.id, w.isPrimary, w.isOrphan, w.label])).toEqual([
    ['/repo', true, false, undefined],
    ['a', false, false, 'Feature A'],
    ['gone', false, true, undefined],
  ])
})

it('shares one status subscription per checkout and keeps the snapshot stable', async () => {
  const snaps: GitStatusSnapshot[] = []
  function Probe() { snaps.push(useGitStatus('ws', '/repo')); useGitStatus('ws', '/repo'); return null }
  await m.render(<Probe />)
  expect(rt.vcs.status).toHaveBeenCalledTimes(1)
  const last = snaps[snaps.length - 1]
  expect(last.branch).toBe('main')
  await m.render(<Probe />)
  expect(snaps[snaps.length - 1]).toBe(last)
})

it('shows no metadata for a nested repository', async () => {
  let seen: JoinedWorktree[] = []
  function Probe() { seen = useWorktrees('/repo/nested'); return null }
  await m.render(<Probe />, fakeHost({ worktrees: [{ id: 'gone', path: '/elsewhere', color: 'red', status: 'ready' }] }))
  expect(seen).toEqual([])
})
