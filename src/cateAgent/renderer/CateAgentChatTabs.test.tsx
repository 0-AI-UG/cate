// @vitest-environment jsdom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatDragState } from '../../renderer/drag/chatDragState'
import { useChatsStore } from '../../renderer/stores/chatsStore'
import { CateAgentChatTabs } from './CateAgentChatTabs'
import { useCateAgentStore } from './cateAgentStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
    projectChatsSave: vi.fn(),
  }
  useCateAgentStore.setState({
    byWs: { 'ws-1': { activeChatId: 'chat-a' } },
    activeChatByPanel: {},
  })
  useChatsStore.setState({
    chatsByRoot: {
      '/repo': [
        { id: 'chat-a', title: 'Chat A', createdAt: 1, updatedAt: 1 },
        { id: 'chat-b', title: 'Chat B', createdAt: 2, updatedAt: 2 },
      ],
    },
    loadedRoots: { '/repo': true },
  })
  useChatDragState.setState({ active: null, destinationHostPanelId: undefined })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('CateAgentChatTabs', () => {
  it('reveals a horizontal scrollbar on hover while keeping chats draggable', () => {
    act(() => root.render(<CateAgentChatTabs wsId="ws-1" rootPath="/repo" />))

    const strip = host.querySelector('.overflow-x-auto') as HTMLDivElement
    const chatB = [...host.querySelectorAll<HTMLElement>('[role="tab"]')]
      .find((tab) => tab.textContent?.includes('Chat B'))!

    expect(strip.classList).not.toContain('no-scrollbar')
    expect(strip.classList).toContain('cate-agent-chat-tabs-scroll')
    expect(strip.parentElement?.classList).toContain('cate-agent-chat-tabs')
    expect(chatB.draggable).toBe(true)
  })

  it('shows and creates only chats owned by a panel', () => {
    useChatsStore.setState({
      chatsByRoot: {
        '/repo': [
          { id: 'sidebar-chat', title: 'Sidebar chat', createdAt: 1, updatedAt: 1 },
          {
            id: 'panel-chat',
            title: 'Panel chat',
            createdAt: 2,
            updatedAt: 2,
            hostPanelId: 'panel-1',
          },
          {
            id: 'other-panel-chat',
            title: 'Other panel chat',
            createdAt: 3,
            updatedAt: 3,
            hostPanelId: 'panel-2',
          },
        ],
      },
      loadedRoots: { '/repo': true },
    })
    const onActiveChatChange = vi.fn()

    act(() => root.render(
      <CateAgentChatTabs
        wsId="ws-1"
        rootPath="/repo"
        panelId="panel-1"
        activeChatId="panel-chat"
        onActiveChatChange={onActiveChatChange}
      />,
    ))

    expect(host.textContent).toContain('Panel chat')
    expect(host.textContent).not.toContain('Sidebar chat')
    expect(host.textContent).not.toContain('Other panel chat')

    act(() => {
      host.querySelector<HTMLButtonElement>('button[title="New chat"]')!.click()
    })

    const created = useChatsStore.getState().getChats('/repo').at(-1)!
    expect(created.hostPanelId).toBe('panel-1')
    expect(onActiveChatChange).toHaveBeenCalledWith(created.id)
  })
})
