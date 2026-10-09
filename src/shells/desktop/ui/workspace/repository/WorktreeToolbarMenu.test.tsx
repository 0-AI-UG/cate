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
    panels: [{ id: 'c', type: 'chat', title: 'C', worktreeId: 'a', fields: {} }],
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
