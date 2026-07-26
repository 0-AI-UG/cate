// @vitest-environment jsdom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useChatsStore } from '../../renderer/stores/chatsStore'
import {
  useActiveChatWorktreeByPanel,
  useCateAgentStore,
} from './cateAgentStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  useCateAgentStore.setState({ byWs: {}, activeChatByPanel: {} })
  useChatsStore.setState({
    chatsByRoot: {
      '/repo': [
        { id: 'chat-a', title: 'A', createdAt: 1, updatedAt: 1, worktreeId: 'wt-a' },
        { id: 'chat-b', title: 'B', createdAt: 2, updatedAt: 2, worktreeId: 'wt-b' },
      ],
    },
    loadedRoots: { '/repo': true },
  })
})

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

describe('active Cate Agent chat worktree projection', () => {
  it('reactively follows chat switches for canvas terrace membership', () => {
    let current: Record<string, string> = {}
    const Probe = () => {
      current = useActiveChatWorktreeByPanel()
      return null
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => root?.render(<Probe />))

    act(() => useCateAgentStore.getState().setPanelActiveChat('agent-panel', 'chat-a'))
    expect(current['agent-panel']).toBe('wt-a')

    act(() => useCateAgentStore.getState().setPanelActiveChat('agent-panel', 'chat-b'))
    expect(current['agent-panel']).toBe('wt-b')

    act(() => useCateAgentStore.getState().setPanelActiveChat('agent-panel', null))
    expect(current['agent-panel']).toBeUndefined()
  })
})
