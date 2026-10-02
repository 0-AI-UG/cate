import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcError } from '@kernel/rpc/contract'
import { installMockClientUi } from '@kernel/ui/testing'
import type { JoinedWorktree } from '../contract'
import type { RepositoryUiHost } from './context'
import type { ContextMenuItem } from '@kernel/ui/contract'
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
async function render(host: RepositoryUiHost = fakeHost()) {
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

  it('keeps an existing folder when its status is unavailable', async () => {
    await render()
    await act(async () => { await api.handleDelete(wt) })
    expect(ui.confirm).not.toHaveBeenCalled()
    expect(setError).toHaveBeenCalledWith('Couldn’t verify this worktree before discarding it. No files were removed.')
  })
})

describe('other actions', () => {
  it('prunes only after every orphan’s panels agreed to close', async () => {
    const prepare = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    await render(fakeHost({ prepareWorktreeClose: prepare }))
    await act(async () => { await api.handlePrune([wt, { ...wt, id: 'wt2' }]) })
    expect(rt.vcs.worktreePrune).not.toHaveBeenCalled()
    prepare.mockResolvedValue(true)
    await act(async () => { await api.handlePrune([wt]) })
    expect(rt.vcs.worktreePrune).toHaveBeenCalled()
  })

  it('refuses direct PR creation for a worktree that already belongs to a PR', async () => {
    await render()
    await act(async () => { await api.handleCreatePR({ ...wt, prNumber: 9 }) })
    expect(rt.vcs.createPr).not.toHaveBeenCalled()
    expect(setError).toHaveBeenCalledWith('This worktree already belongs to PR #9. Open that pull request instead.')
  })

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
