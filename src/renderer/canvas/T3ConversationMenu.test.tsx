// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { T3ConversationMenu } from './T3ConversationMenu'

const { createAgent, updateTitle, list, state, inherit, remove } = vi.hoisted(() => {
  const createAgent = vi.fn(() => 'panel')
  const updateTitle = vi.fn()
  return { remove: vi.fn(), inherit: vi.fn(() => ({})), createAgent, updateTitle, list: vi.fn(), state: { workspaces: [{ id: 'ws', worktrees: [] }], createAgent, updatePanelTitleFromAgent: updateTitle } }
})
vi.mock('../stores/appStore', () => ({ useAppStore: Object.assign((select: (s: typeof state) => unknown) => select(state), { getState: () => state }) }))
vi.mock('../stores/CanvasStoreContext', () => ({ useCanvasStoreApi: () => ({ getState: () => ({}) }) }))
vi.mock('../lib/inheritWorktree', () => ({ inheritedWorktreeFromSelection: inherit }))
vi.mock('../ui/Tooltip', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => children }))
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.clearAllMocks()
  inherit.mockReturnValue({})
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  ;(window as unknown as { electronAPI: unknown }).electronAPI = { agentHarnessListConversations: list, agentHarnessDeleteConversation: remove }
  list.mockResolvedValue([{ id: 'one', title: 'Fix login', updatedAt: '2026-09-05' }, { id: 'two', title: 'Add tests', updatedAt: '2026-09-04' }])
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })
async function open() {
  await act(async () => root.render(<T3ConversationMenu canvasPanelId="canvas" workspaceId="ws" rootPath="/repo" tooltipPlacement="top" menuSide="up" onOpenChange={() => {}} />))
  expect(list).not.toHaveBeenCalled()
  await act(async () => host.querySelector('button')!.click())
}
it('loads saved conversations on demand and creates a bound panel through placement', async () => {
  await open()
  expect(list).toHaveBeenCalledWith({ workspaceId: 'ws', cwd: '/repo' })
  const input = document.querySelector('input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'login')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(document.querySelector('[role="dialog"]')!.textContent).not.toContain('Add tests')
  await act(async () => (document.querySelector('button[title="Fix login"]') as HTMLButtonElement).click())
  expect(createAgent).toHaveBeenCalledWith('ws', undefined, { target: 'canvas', canvasPanelId: 'canvas' }, '/repo', undefined, 'one')
  expect(updateTitle).toHaveBeenCalledWith('ws', 'panel', 'Fix login')
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})
it('creates a new unbound conversation through the same placement flow', async () => {
  await open()
  const button = [...document.querySelectorAll('button')].find((el) => el.textContent === 'New conversation')!
  await act(async () => button.click())
  expect(createAgent).toHaveBeenCalledWith('ws', undefined, { target: 'canvas', canvasPanelId: 'canvas' }, '/repo', undefined, undefined)
  expect(updateTitle).not.toHaveBeenCalled()
})
it('surfaces conversation loading failures', async () => {
  list.mockResolvedValue({ error: 'Runtime unavailable' })
  await open()
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('Runtime unavailable')
})

it('inherits terminal worktree context without a separate selector', async () => {
  inherit.mockReturnValue({ cwd: '/repo/feature', worktreeId: 'feature' })
  await open()
  expect(document.querySelector('select')).toBeNull()
  expect(list).toHaveBeenCalledWith({ workspaceId: 'ws', cwd: '/repo/feature' })
  await act(async () => (document.querySelector('button[title="Fix login"]') as HTMLButtonElement).click())
  expect(createAgent).toHaveBeenCalledWith('ws', undefined, { target: 'canvas', canvasPanelId: 'canvas' }, '/repo/feature', 'feature', 'one')
})

it('requires confirmation before deleting a saved chat', async () => {
  remove.mockResolvedValue({ ok: true })
  await open()
  await act(async () => (document.querySelector('button[aria-label="Delete Fix login"]') as HTMLButtonElement).click())
  expect(remove).not.toHaveBeenCalled()
  await act(async () => [...document.querySelectorAll('button')].find((button) => button.textContent === 'Delete')!.click())
  expect(remove).toHaveBeenCalledWith({ workspaceId: 'ws', cwd: '/repo', threadId: 'one' })
  expect(document.querySelector('button[title="Fix login"]')).toBeNull()
  expect(document.querySelector('button[title="Add tests"]')).not.toBeNull()
})
it('keeps the conversation when deletion fails', async () => {
  remove.mockResolvedValue({ error: 'Deletion failed' })
  await open()
  await act(async () => (document.querySelector('button[aria-label="Delete Fix login"]') as HTMLButtonElement).click())
  await act(async () => [...document.querySelectorAll('button')].find((button) => button.textContent === 'Delete')!.click())
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('Deletion failed')
  await act(async () => [...document.querySelectorAll('button')].find((button) => button.textContent === 'Cancel')!.click())
  expect(document.querySelector('button[title="Fix login"]')).not.toBeNull()
})
