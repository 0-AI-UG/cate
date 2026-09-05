// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { T3ConversationPill } from './T3ConversationPill'
import type { PanelState } from '../../shared/types'

const { state, list, menu, select, title } = vi.hoisted(() => {
  const select = vi.fn(), title = vi.fn()
  const panel = { id: 'agent', type: 'agent', title: 'Current chat', agentThreadId: 'one', worktreeId: 'feature' }
  return {
    select, title, list: vi.fn(), menu: vi.fn(),
    state: { workspaces: [{ id: 'ws', rootPath: '/repo', worktrees: [{ id: 'feature', path: '/repo/feature' }], panels: { agent: panel } }], setPanelAgentThreadId: select, updatePanelTitleFromAgent: title },
  }
})
vi.mock('../stores/appStore', () => ({ useAppStore: { getState: () => state } }))
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.clearAllMocks()
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  ;(window as unknown as { electronAPI: unknown }).electronAPI = { agentHarnessListConversations: list, showContextMenu: menu }
  list.mockResolvedValue([{ id: 'one', title: 'Current chat', updatedAt: '2026-09-04' }, { id: 'two', title: 'Other chat', updatedAt: '2026-09-05' }])
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })
async function open() {
  await act(async () => root.render(<T3ConversationPill panel={state.workspaces[0].panels.agent as PanelState} workspaceId="ws" />))
  await act(async () => host.querySelector('button')!.click())
}
it('lists chats for the checkout and switches the existing panel', async () => {
  menu.mockResolvedValue('two')
  await open()
  expect(list).toHaveBeenCalledWith({ workspaceId: 'ws', cwd: '/repo/feature' })
  expect(menu.mock.calls[0][0].slice(2)).toEqual([{ id: 'two', label: 'Other chat' }, { id: 'one', label: 'Current chat  ✓' }])
  expect(select).toHaveBeenCalledWith('ws', 'agent', 'two')
  expect(title).toHaveBeenCalledWith('ws', 'agent', 'Other chat')
})
it('starts a new chat in the existing panel', async () => {
  menu.mockResolvedValue('__new')
  await open()
  expect(select).toHaveBeenCalledWith('ws', 'agent', undefined)
})
it('leaves the chat unchanged when the menu is dismissed', async () => {
  menu.mockResolvedValue(null)
  await open()
  expect(select).not.toHaveBeenCalled()
})
