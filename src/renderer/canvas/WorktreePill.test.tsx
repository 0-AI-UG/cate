// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PanelState } from '../../shared/types'

const h = vi.hoisted(() => ({
  confirm: vi.fn(), respawn: vi.fn(), setWorktree: vi.fn(), hover: vi.fn(), focus: vi.fn(),
}))
vi.mock('../stores/useWorktrees', () => ({ useWorktrees: () => [
  { id: 'main', path: '/repo', branch: 'main', isPrimary: true },
  { id: 'feature', path: '/feature', branch: 'feature', color: '#55aa77' },
] }))
vi.mock('../stores/appStore', () => ({ useAppStore: Object.assign((selector: any) => selector({ workspaces: [{ id: 'ws', rootPath: '/repo' }] }), {
  getState: () => ({ respawnPanelTerminal: h.respawn, setPanelWorktreeId: h.setWorktree }),
}) }))
vi.mock('../stores/uiStore', () => ({ useUIStore: (selector: any) => selector({ setHoveredWorktree: h.hover, focusWorktree: h.focus, focusedWorktreeId: null }) }))
vi.mock('../lib/confirmCloseTerminal', () => ({ confirmCloseRunningTerminals: h.confirm }))
import { WorktreePill } from './WorktreePill'

let host: HTMLDivElement
let root: Root
const terminal: PanelState = { id: 'panel', type: 'terminal', title: 'Terminal', isDirty: false, worktreeId: 'main' }
beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  vi.clearAllMocks()
  window.electronAPI.showContextMenu = vi.fn().mockResolvedValue('feature')
  host = document.createElement('div')
  root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()) })

it.each([false, true])('preserves terminal restart confirmation (accepted=%s)', async (accepted) => {
  h.confirm.mockResolvedValue(accepted)
  act(() => root.render(<WorktreePill workspaceId="ws" panel={terminal} />))
  await act(async () => host.querySelector('button')!.click())
  expect(h.confirm).toHaveBeenCalledWith([terminal])
  if (accepted) expect(h.respawn).toHaveBeenCalledWith('ws', 'panel', '/feature', 'feature')
  else expect(h.respawn).not.toHaveBeenCalled()
  expect(h.setWorktree).not.toHaveBeenCalled()
})

it('switches agent checkout without restarting a terminal', async () => {
  act(() => root.render(<WorktreePill workspaceId="ws" panel={{ ...terminal, type: 'agent' }} />))
  await act(async () => host.querySelector('button')!.click())
  expect(h.setWorktree).toHaveBeenCalledWith('ws', 'panel', 'feature')
  expect(h.confirm).not.toHaveBeenCalled()
  expect(h.respawn).not.toHaveBeenCalled()
})

it('keeps canvas focus and hover highlighting on the overlay', async () => {
  act(() => root.render(<WorktreePill workspaceId="ws" panel={terminal} />))
  const button = host.querySelector('button')!
  act(() => button.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
  expect(h.hover).toHaveBeenLastCalledWith('main')
  window.electronAPI.showContextMenu = vi.fn().mockResolvedValue('__focus')
  await act(async () => button.click())
  expect(h.focus).toHaveBeenCalledWith('main')
  act(() => root.render(null))
  expect(h.hover).toHaveBeenLastCalledWith(null)
})
