import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcError } from '@kernel/rpc/contract'
import { installMockClientUi } from '../../../../../test/clientUi'
import type { JoinedWorktree } from '@workspace/repository/contract'
import type { RepositoryHost } from '@workspace/repository/client'
import type { ContextMenuItem } from '@kernel/interaction/contract'
import { runWorktreeContextMenu, useParallelWork, type ParallelWork } from './parallelWork'
import { fakeHost, installFakeRuntime, mount, type Mounted } from './testing'

let m: Mounted
let rt: ReturnType<typeof installFakeRuntime>
let ui: ReturnType<typeof installMockClientUi>
const menu = vi.fn<(items: ContextMenuItem[]) => Promise<string | null>>()
const confirmText = (i = 0) => String(ui.confirm.mock.calls[i]?.[0 as never])
let api: ParallelWork
const setError = vi.fn()
const setBusy = vi.fn()
const wt: JoinedWorktree = { id: 'wt', path: '/repo/.cate/worktrees/feat', branch: 'feat', isPrimary: false, isCurrent: false, isOrphan: false, color: 'cyan' }

function Probe() {
  api = useParallelWork('main', { setError, setBusy })
  return null
}
async function render(host: RepositoryHost = fakeHost()) {
  await m.render(<Probe />, host)
  return host
}

beforeEach(() => {
  rt = installFakeRuntime()
  menu.mockReset().mockResolvedValue(null)
  ui = installMockClientUi({ showContextMenu: menu })
  setError.mockReset()
  setBusy.mockReset()
  m = mount()
})
afterEach(() => { m.unmount(); rt.uninstall() })

describe('create', () => {
  it('sanitizes the branch and keeps the typed text as the label', async () => {
    await render()
    await act(async () => { await api.createWorktree('fix the login', 'develop') })
    expect(rt.vcs.worktreeCreate).toHaveBeenCalledWith({ branch: 'fix-the-login', base: 'develop', label: 'fix the login' })
  })

  it('rejects an empty sanitized name before calling the runtime', async () => {
    await render()
    await expect(api.createWorktree('  !! ')).rejects.toThrow('Please enter a name')
    expect(rt.vcs.worktreeCreate).not.toHaveBeenCalled()
  })

  it('checks out a PR by number', async () => {
    await render()
    await act(async () => { await api.checkoutPr({ number: 7, title: 't', headRefName: 'fix', author: 'a', isFork: false }) })
    expect(rt.vcs.worktreeCreate).toHaveBeenCalledWith({ branch: 'fix', fromPr: 7, label: '#7 fix' })
  })
})

describe('handleDelete', () => {
  it('uses fresh dirty status for the warning and force-removes', async () => {
    rt.vcs.worktreeStatus.mockResolvedValue({ branch: 'feat', dirty: true, ahead: 2, behind: 0, staged: 0, unstaged: 1, untracked: 0 })
    ui.confirm.mockResolvedValue(true)
    const host = await render(fakeHost({ worktreePanelSummary: vi.fn(() => ({ count: 2, hasDirtyEditor: false })) }))
    await act(async () => { await api.handleDelete(wt) })
    const message = confirmText()
    expect(message).toContain('Its 2 open panels will be closed.')
    expect(message).toContain('uncommitted changes')
    expect(message).toContain('2 unpublished commit(s)')
    expect(host.prepareWorktreeClose).toHaveBeenCalledWith('wt')
    expect(rt.vcs.worktreeRemove).toHaveBeenCalledWith({ worktreeId: 'wt', force: true })
    expect(setBusy).toHaveBeenLastCalledWith(null)
  })

  it('does nothing when the person cancels', async () => {
    rt.vcs.worktreeStatus.mockResolvedValue({ branch: 'feat', dirty: false, ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0 })
    const host = await render()
    await act(async () => { await api.handleDelete(wt) })
    expect(host.prepareWorktreeClose).not.toHaveBeenCalled()
    expect(rt.vcs.worktreeRemove).not.toHaveBeenCalled()
  })

  it('stops before removal when the unsaved-work gate is cancelled', async () => {
    rt.vcs.worktreeStatus.mockResolvedValue({ branch: 'feat', dirty: false, ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0 })
    ui.confirm.mockResolvedValue(true)
    await render(fakeHost({ prepareWorktreeClose: vi.fn().mockResolvedValue(false) }))
    await act(async () => { await api.handleDelete(wt) })
    expect(rt.vcs.worktreeRemove).not.toHaveBeenCalled()
  })

  it('reports a branch that could not be deleted', async () => {
    rt.vcs.worktreeStatus.mockResolvedValue({ branch: 'feat', dirty: false, ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0 })
    rt.vcs.worktreeRemove.mockResolvedValue({ branchDeleteError: 'not merged' })
    ui.confirm.mockResolvedValue(true)
    await render()
    await act(async () => { await api.handleDelete(wt) })
    expect(rt.vcs.worktreeRemove).toHaveBeenCalledWith({ worktreeId: 'wt', force: false })
    expect(setError).toHaveBeenLastCalledWith('Removed, but branch feat could not be deleted: not merged')
  })

  it('offers cleanup of a missing folder', async () => {
    rt.file.stat.mockRejectedValue(new RpcError('gone', 'ENOENT'))
    ui.confirm.mockResolvedValue(true)
    await render()
    await act(async () => { await api.handleDelete(wt) })
    expect(confirmText()).toContain('The worktree folder is missing.')
    expect(rt.vcs.worktreeRemove).toHaveBeenCalledWith({ worktreeId: 'wt', force: false })
  })

  it('offers removal with an explicit warning when status is unavailable', async () => {
    ui.confirm.mockResolvedValue(true)
    await render()
    await act(async () => { await api.handleDelete(wt) })
    expect(confirmText()).toContain('Git status could not be read')
    expect(rt.vcs.worktreeRemove).toHaveBeenCalledWith({ worktreeId: 'wt', force: true })
  })

  it('keeps files when the unknown-status warning is cancelled', async () => {
    await render()
    await api.handleDelete(wt)
    expect(ui.confirm).toHaveBeenCalledTimes(1)
    expect(rt.vcs.worktreeRemove).not.toHaveBeenCalled()
  })

  it('cleans up a missing folder even when Git status throws', async () => {
    rt.vcs.worktreeStatus.mockRejectedValue(new Error('not a git repository'))
    rt.file.stat.mockRejectedValue(new RpcError('gone', 'ENOENT'))
    ui.confirm.mockResolvedValue(true)
    await render()
    await api.handleDelete(wt)
    expect(confirmText()).toContain('The worktree folder is missing.')
    expect(rt.vcs.worktreeRemove).toHaveBeenCalledWith({ worktreeId: 'wt', force: false })
  })

  it('does not treat a filesystem permission error as a missing folder', async () => {
    rt.file.stat.mockRejectedValue(new Error('EACCES'))
    await render()
    await api.handleDelete(wt)
    expect(confirmText()).toContain('Git status could not be read')
    expect(confirmText()).not.toContain('The worktree folder is missing.')
    expect(rt.vcs.worktreeRemove).not.toHaveBeenCalled()
  })

  it('silently completes cleanup when an unregistered checkout’s files were preserved', async () => {
    rt.vcs.worktreeRemove.mockResolvedValue({ preservedPath: wt.path })
    ui.confirm.mockResolvedValue(true)
    await render()
    await api.handleDelete(wt)
    expect(setError).toHaveBeenLastCalledWith(null)
  })

})

describe('other actions', () => {
  it('writes rename and recolor as metadata, creating it for an untracked checkout', async () => {
    const host = await render(fakeHost({ worktrees: [{ id: 'wt', path: wt.path, color: 'cyan', label: 'old', status: 'ready' }] }))
    act(() => api.makeCallbacks(wt).onRename(undefined))
    expect(host.setWorktree).toHaveBeenLastCalledWith({ id: 'wt', path: wt.path, color: 'cyan', status: 'ready' })
    act(() => api.makeCallbacks(wt).onRecolor('magenta'))
    expect(host.setWorktree).toHaveBeenLastCalledWith({ id: 'wt', path: wt.path, color: 'magenta', label: 'old', status: 'ready' })
    act(() => api.makeCallbacks({ ...wt, id: '/other', path: '/other' }).onRename('New'))
    expect(host.setWorktree).toHaveBeenLastCalledWith(expect.objectContaining({ path: '/other', label: 'New', status: 'ready' }))
  })

  it('reports menu failures through the error channel and omits base actions without a base', async () => {
    const onError = vi.fn()
    menu.mockRejectedValue(new Error('boom'))
    await render()
    const cb = { ...api.makeCallbacks(wt), onError }
    await runWorktreeContextMenu({ isPrimary: false, hasPr: false, primaryLabel: '', cb })
    expect(onError).toHaveBeenCalledWith('Couldn’t open worktree actions: boom')
    const items = menu.mock.calls[0][0]
    expect(items.map((i) => i.id)).not.toContain('merge')
    expect(items.map((i) => i.id)).toContain('delete')
  })
})


describe('bulk deletion', () => {
  const second = { ...wt, id: 'wt2', branch: 'second', path: '/repo/.cate/worktrees/second' }
  beforeEach(() => {
    rt.vcs.worktreeStatus.mockResolvedValue({ branch: 'feat', dirty: true, ahead: 2, behind: 0, staged: 0, unstaged: 1, untracked: 0 })
    ui.confirm.mockResolvedValue(true)
  })

  it('confirms once for all worktrees and excludes the primary checkout', async () => {
    await render()
    let removed: string[] = []
    await act(async () => { removed = await api.handleDeleteSelected([wt, second, { ...wt, id: 'main', isPrimary: true }, wt]) })
    expect(ui.confirm).toHaveBeenCalledTimes(1)
    expect(confirmText()).toContain('Delete 2 worktrees?')
    expect(confirmText()).toContain('“feat”')
    expect(confirmText()).toContain('“second”')
    expect(confirmText()).toContain('uncommitted changes')
    expect(confirmText()).toContain('2 unpublished commit(s)')
    expect(removed).toEqual(['wt', 'wt2'])
    expect(rt.vcs.worktreeRemove).toHaveBeenCalledTimes(2)
  })

  it('includes unreadable checkouts in the combined warning instead of blocking the batch', async () => {
    rt.vcs.worktreeStatus.mockResolvedValueOnce({ dirty: false, ahead: 0 }).mockRejectedValueOnce(new Error('offline'))
    await render()
    expect(await api.handleDeleteSelected([wt, second])).toEqual(['wt', 'wt2'])
    expect(ui.confirm).toHaveBeenCalledTimes(1)
    expect(confirmText()).toContain('Git status could not be read')
    expect(rt.vcs.worktreeRemove).toHaveBeenCalledWith({ worktreeId: 'wt2', force: true })
  })

  it('removes nothing when any selected worktree’s close guard is cancelled', async () => {
    await render(fakeHost({ prepareWorktreeClose: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false) }))
    expect(await api.handleDeleteSelected([wt, second])).toEqual([])
    expect(rt.vcs.worktreeRemove).not.toHaveBeenCalled()
  })

  it('continues after a removal failure and returns only successful ids', async () => {
    rt.vcs.worktreeRemove.mockRejectedValueOnce(new Error('locked')).mockResolvedValueOnce({})
    await render()
    expect(await api.handleDeleteSelected([wt, second])).toEqual(['wt2'])
    expect(setError).toHaveBeenLastCalledWith(expect.stringContaining('locked'))
    expect(setBusy).toHaveBeenLastCalledWith(null)
  })

  it('cleans up a checkout that disappears while the confirmation is open', async () => {
    rt.vcs.worktreeStatus.mockResolvedValueOnce({ dirty: false, ahead: 0 }).mockResolvedValueOnce(null)
    rt.file.stat.mockRejectedValue(new RpcError('gone', 'ENOENT'))
    await render()
    expect(await api.handleDeleteSelected([wt])).toEqual(['wt'])
    expect(rt.vcs.worktreeRemove).toHaveBeenCalledWith({ worktreeId: 'wt', force: false })
  })

  it('keeps a checkout if status disappears after confirmation', async () => {
    rt.vcs.worktreeStatus.mockResolvedValueOnce({ dirty: false, ahead: 0 }).mockResolvedValueOnce(null)
    await render()
    expect(await api.handleDeleteSelected([wt])).toEqual([])
    expect(rt.vcs.worktreeRemove).not.toHaveBeenCalled()
  })
})
