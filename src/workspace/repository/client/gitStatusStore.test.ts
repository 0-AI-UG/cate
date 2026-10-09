import { expect, it, vi } from 'vitest'
import { EMPTY_REPO_STATUS, type RepoStatus } from '../contract'
import { createGitStatusStore, EMPTY_GIT_STATUS, type GitStatusClient } from './gitStatusStore'

function fakeVcs(files: string[] = ['a.ts', 'src/b.ts']) {
  const subs: Array<{ cwd?: string; emit: (s: RepoStatus) => void; fail: (e: unknown) => void; cancel: ReturnType<typeof vi.fn> }> = []
  const lsFiles = vi.fn(async () => files)
  const vcs = {
    lsFiles,
    status: (params: { cwd?: string }) => {
      const listeners = new Set<(e: unknown) => void>()
      let fail!: (e: unknown) => void
      const done = new Promise<void>((_resolve, reject) => { fail = reject })
      let rev = -1
      const sub = {
        cwd: params.cwd,
        emit: (s: RepoStatus) => {
          rev++
          const event = rev === 0 ? { kind: 'snapshot', rev, snapshot: s } : { kind: 'change', rev, change: s }
          listeners.forEach((l) => l(event))
        },
        fail,
        cancel: vi.fn(),
      }
      subs.push(sub)
      return { onEvent: (l: (e: unknown) => void) => { listeners.add(l); return () => listeners.delete(l) }, done, cancel: sub.cancel }
    },
  } as unknown as GitStatusClient
  return { vcs, subs, lsFiles }
}

const status = (patch: Partial<RepoStatus> = {}): RepoStatus => ({ ...EMPTY_REPO_STATUS, isRepo: true, branch: 'main', ...patch })

it('shares one subscription per checkout and mirrors its snapshots', async () => {
  const { vcs, subs, lsFiles } = fakeVcs()
  const store = createGitStatusStore(vcs)
  const a = vi.fn()
  const offA = store.subscribe('/repo', a)
  const offB = store.subscribe('/repo/', vi.fn())
  expect(subs).toHaveLength(1)
  expect(store.getSnapshot('/repo')).toBe(EMPTY_GIT_STATUS)

  subs[0].emit(status({ dirty: true }))
  expect(store.getSnapshot('/repo')).toMatchObject({ isRepo: true, branch: 'main', dirty: true, revision: 1 })
  await vi.waitFor(() => expect(store.getSnapshot('/repo').tracked).toEqual(new Set(['/repo/a.ts', '/repo/src/b.ts'])))

  // The same files and branch do not refetch the tracked list.
  subs[0].emit(status({ dirty: true, ahead: 1 }))
  expect(lsFiles).toHaveBeenCalledTimes(1)
  expect(a).toHaveBeenCalledTimes(3)

  offA()
  expect(subs[0].cancel).not.toHaveBeenCalled()
  offB()
  expect(subs[0].cancel).toHaveBeenCalledOnce()
  expect(store.getSnapshot('/repo')).toBe(EMPTY_GIT_STATUS)
})

it('shows no repo when the subscription fails', async () => {
  const { vcs, subs } = fakeVcs()
  const store = createGitStatusStore(vcs)
  store.subscribe('/repo', vi.fn())
  subs[0].emit(status())
  subs[0].fail(new Error('untrusted'))
  await vi.waitFor(() => expect(store.getSnapshot('/repo').isRepo).toBe(false))
  store.dispose()
  expect(subs[0].cancel).toHaveBeenCalledOnce()
})
