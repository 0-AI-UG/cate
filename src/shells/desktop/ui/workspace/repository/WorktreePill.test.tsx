import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installMockClientUi } from '@kernel/interaction/testing'
import type { PanelRecord } from '@workspace/document/contract'
import { WorktreePill } from './WorktreePill'
import { fakeHost, fakeVcs, installFakeRuntime, mount, type Mounted } from './testing'

let m: Mounted
let rt: ReturnType<typeof installFakeRuntime>
const menu = vi.fn<() => Promise<string | null>>()
const terminal: PanelRecord = { id: 'panel', type: 'terminal', title: 'Terminal', worktreeId: 'main', fields: {} }
const worktrees = [
  { id: 'main', path: '/repo', color: 'green', status: 'ready' as const },
  { id: 'feature', path: '/feature', color: 'cyan', status: 'ready' as const },
]
beforeEach(() => {
  rt = installFakeRuntime(fakeVcs(() => ({
    worktrees: [
      { path: '/repo', branch: 'main', isBare: false, isCurrent: true },
      { path: '/feature', branch: 'feature', isBare: false, isCurrent: false },
    ],
  })))
  menu.mockReset().mockResolvedValue('feature')
  installMockClientUi({ showContextMenu: menu })
  m = mount()
})
afterEach(() => { m.unmount(); rt.uninstall() })

it('switches the panel to the picked worktree through the client', async () => {
  const host = fakeHost({ worktrees })
  await m.render(<WorktreePill panel={terminal} />, host)
  await act(async () => m.host.querySelector('button')!.click())
  expect(host.switchPanelWorktree).toHaveBeenCalledWith('panel', 'feature')
})

it('stays hidden for panel types that do not bind a worktree', async () => {
  await m.render(<WorktreePill panel={{ ...terminal, type: 'editor' }} />, fakeHost({ worktrees }))
  expect(m.host.querySelector('button')).toBeNull()
})

it('keeps canvas focus and hover highlighting on the overlay', async () => {
  const host = fakeHost({ worktrees })
  await m.render(<WorktreePill panel={terminal} />, host)
  const button = m.host.querySelector('button')!
  act(() => button.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
  expect(host.setHoveredWorktree).toHaveBeenLastCalledWith('main')
  menu.mockResolvedValue('__focus')
  await act(async () => button.click())
  expect(host.focusWorktree).toHaveBeenCalledWith('main')
  await m.render(null)
  expect(host.setHoveredWorktree).toHaveBeenLastCalledWith(null)
})
