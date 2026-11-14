import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installMockClientUi } from '../../../../../test/clientUi'
import { WorktreeToolbarMenu } from './WorktreeToolbarMenu'
import { fakeHost, fakeVcs, installFakeRuntime, mount, type Mounted } from './testing'

let m: Mounted
let rt: ReturnType<typeof installFakeRuntime>
const trigger = ({ ref, onClick }: { ref: React.RefObject<HTMLButtonElement>; onClick: () => void }) =>
  <button ref={ref} onClick={onClick}>Parallel worktrees</button>

beforeEach(() => {
  rt = installFakeRuntime(fakeVcs(() => ({
    branch: 'main',
    worktrees: [
      { path: '/repo', branch: 'main', isBare: false, isCurrent: true },
      { path: '/repo/.cate/worktrees/a', branch: 'a', isBare: false, isCurrent: false },
    ],
  })))
  installMockClientUi({ showContextMenu: vi.fn().mockResolvedValue(null) })
  m = mount()
})
afterEach(() => { m.unmount(); rt.uninstall(); document.body.innerHTML = '' })

it('lists worktrees with open panel counts and launches a terminal on this canvas', async () => {
  const host = fakeHost({
    worktrees: [{ id: 'a', path: '/repo/.cate/worktrees/a', color: 'cyan', label: 'Feature A', status: 'ready' }],
    panels: [{ id: 'c', type: 'terminal', title: 'C', worktreeId: 'a', fields: {} }],
  })
  await m.render(<WorktreeToolbarMenu canvasPanelId="canvas" renderTrigger={trigger} />, host)
  await act(async () => m.button('Parallel worktrees').click())
  await act(async () => { await Promise.resolve() })
  expect(document.body.textContent).toContain('Feature A')
  expect(document.body.textContent).toContain('main')
  const terminals = document.body.querySelectorAll<HTMLElement>('[aria-label="Terminal"]')
  await act(async () => terminals[1].click())
  expect(host.launchInWorktree).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), 'terminal', { canvasPanelId: 'canvas' })
})

it('offers git init outside a repository', async () => {
  rt.uninstall()
  rt = installFakeRuntime(fakeVcs(() => null))
  await m.render(<WorktreeToolbarMenu canvasPanelId="canvas" renderTrigger={trigger} />, fakeHost())
  await act(async () => m.button('Parallel worktrees').click())
  const init = [...document.body.querySelectorAll('button')].find((b) => b.textContent === 'Initialize git repository')!
  await act(async () => init.click())
  expect(rt.vcs.init).toHaveBeenCalledWith({ cwd: '/repo' })
})


const worktreeRow = (label: string) => [...document.body.querySelectorAll<HTMLElement>('[aria-selected]')]
  .find((row) => [...row.querySelectorAll('span')].some((span) => span.textContent === label))!
const clickRow = (label: string, shiftKey = false) => act(async () => {
  worktreeRow(label).dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey }))
})

it('extends existing row selection with Shift and keeps all normal controls', async () => {
  const menu = vi.fn().mockResolvedValue(null)
  installMockClientUi({ showContextMenu: menu })
  const host = fakeHost({ worktrees: [{ id: 'a', path: '/repo/.cate/worktrees/a', color: 'cyan', label: 'Feature A', status: 'ready' }] })
  await m.render(<WorktreeToolbarMenu canvasPanelId="canvas" renderTrigger={trigger} />, host)
  await act(async () => m.button('Parallel worktrees').click())
  await clickRow('main')
  await clickRow('Feature A', true)
  expect(worktreeRow('main').getAttribute('aria-selected')).toBe('true')
  expect(worktreeRow('Feature A').getAttribute('aria-selected')).toBe('true')
  expect(host.focusWorktree).toHaveBeenCalledTimes(1)
  expect(document.body.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)
  expect(document.body.querySelectorAll('[aria-label="More actions"]')).toHaveLength(2)
  expect(document.body.textContent).toContain('Create new worktree…')
  expect(document.body.textContent).not.toContain('Cancel')
  await clickRow('Feature A')
  expect(worktreeRow('main').getAttribute('aria-selected')).toBe('false')
  expect(worktreeRow('Feature A').getAttribute('aria-selected')).toBe('true')
  await clickRow('Feature A')
  expect(worktreeRow('Feature A').getAttribute('aria-selected')).toBe('false')
})

it('Shift-selects a range and applies the existing discard action to the selection', async () => {
  rt.uninstall()
  rt = installFakeRuntime(fakeVcs(() => ({
    branch: 'main',
    worktrees: [
      { path: '/repo', branch: 'main', isBare: false, isCurrent: true },
      ...['a', 'b', 'c'].map((branch) => ({ path: `/repo/.cate/worktrees/${branch}`, branch, isBare: false, isCurrent: false })),
    ],
  })))
  const menu = vi.fn().mockResolvedValue('delete')
  const ui = installMockClientUi({ showContextMenu: menu })
  ui.confirm.mockResolvedValue(true)
  rt.vcs.worktreeStatus.mockResolvedValue({ branch: 'a', dirty: false, ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0 })
  rt.vcs.worktreeRemove.mockRejectedValueOnce(new Error('locked')).mockResolvedValue({})
  const host = fakeHost({ worktrees: ['a', 'b', 'c'].map((id) => ({ id, path: `/repo/.cate/worktrees/${id}`, color: 'cyan', status: 'ready' })) })
  await m.render(<WorktreeToolbarMenu canvasPanelId="canvas" renderTrigger={trigger} />, host)
  await act(async () => m.button('Parallel worktrees').click())
  await clickRow('a')
  await clickRow('c', true)
  expect(['a', 'b', 'c'].every((id) => worktreeRow(id).getAttribute('aria-selected') === 'true')).toBe(true)
  await act(async () => worktreeRow('b').querySelector<HTMLButtonElement>('[aria-label="More actions"]')!.click())
  expect(menu).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ id: 'delete', label: 'Discard selected work (3)…' })]))
  expect(ui.confirm).toHaveBeenCalledTimes(1)
  expect(rt.vcs.worktreeRemove.mock.calls.map(([args]) => args.worktreeId)).toEqual(['a', 'b', 'c'])
  expect(worktreeRow('a').getAttribute('aria-selected')).toBe('true')
  expect(worktreeRow('b').getAttribute('aria-selected')).toBe('false')
  expect(worktreeRow('c').getAttribute('aria-selected')).toBe('false')
  expect(document.body.textContent).toContain('locked')
})

it('silently completes removal when a leftover folder is preserved', async () => {
  const ui = installMockClientUi({ showContextMenu: vi.fn().mockResolvedValue('delete') })
  ui.confirm.mockResolvedValue(true)
  rt.vcs.worktreeRemove.mockResolvedValue({ preservedPath: '/repo/.cate/worktrees/a' })
  const host = fakeHost({ worktrees: [{ id: 'a', path: '/repo/.cate/worktrees/a', color: 'cyan', label: 'Feature A', status: 'ready' }] })
  await m.render(<WorktreeToolbarMenu canvasPanelId="canvas" renderTrigger={trigger} />, host)
  await act(async () => m.button('Parallel worktrees').click())
  await clickRow('Feature A')
  await act(async () => worktreeRow('Feature A').querySelector<HTMLButtonElement>('[aria-label="More actions"]')!.click())
  expect(document.body.textContent).not.toContain('Leftover folder')
  expect(document.body.querySelector('.text-red-400\\/90')).toBeNull()
  expect(document.body.querySelector('[role="status"]')).toBeNull()
  expect(worktreeRow('Feature A').getAttribute('aria-selected')).toBe('false')
})


it('shows only a centered spinner until Git confirms whether this is a repository', async () => {
  rt.uninstall()
  let finish!: (status: null) => void
  rt = installFakeRuntime(fakeVcs(() => new Promise((resolve) => { finish = resolve })))
  await m.render(<WorktreeToolbarMenu canvasPanelId="canvas" renderTrigger={trigger} />, fakeHost())
  await act(async () => m.button('Parallel worktrees').click())
  expect(document.body.querySelector('[aria-label="Loading worktrees"]')).not.toBeNull()
  expect(document.body.textContent).not.toContain('Initialize git repository')
  expect(document.body.textContent).not.toContain('Create new worktree')
  await act(async () => finish(null))
  expect(document.body.querySelector('[aria-label="Loading worktrees"]')).toBeNull()
  expect(document.body.textContent).toContain('Initialize git repository')
})


it('blocks panel launches and metadata edits while deletion is pending', async () => {
  const ui = installMockClientUi({ showContextMenu: vi.fn().mockResolvedValue('delete') })
  ui.confirm.mockResolvedValue(true)
  rt.vcs.worktreeStatus.mockResolvedValue({ branch: 'a', dirty: false, ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0 })
  let finish!: (allowed: boolean) => void
  const host = fakeHost({ prepareWorktreeClose: vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve })), worktrees: [{ id: 'a', path: '/repo/.cate/worktrees/a', color: 'cyan', label: 'Feature A', status: 'ready' }] })
  await m.render(<WorktreeToolbarMenu canvasPanelId="canvas" renderTrigger={trigger} />, host)
  await act(async () => m.button('Parallel worktrees').click())
  await clickRow('Feature A')
  await act(async () => worktreeRow('Feature A').querySelector<HTMLButtonElement>('[aria-label="More actions"]')!.click())
  // The selected row stays visible while an unsaved-panel guard is pending.
  const row = worktreeRow('Feature A')
  const launch = row.querySelector<HTMLElement>('[aria-label="Terminal"]')!
  expect(launch.getAttribute('aria-disabled')).toBe('true')
  expect(launch.draggable).toBe(false)
  await act(async () => launch.click())
  expect(host.launchInWorktree).not.toHaveBeenCalled()
  expect(row.querySelector<HTMLButtonElement>('[aria-label="Change color"]')!.disabled).toBe(true)
  await act(async () => row.querySelectorAll('span')[1].dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
  expect(row.querySelector('input')).toBeNull()
  await act(async () => finish(true))
  expect(row.querySelector('[aria-label="Terminal"]')!.getAttribute('aria-disabled')).toBe('false')
})
