import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
Element.prototype.scrollTo = vi.fn()
globalThis.IntersectionObserver = class IntersectionObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] { return [] }
  root = null
  rootMargin = '0px'
  thresholds = [0]
} as unknown as typeof IntersectionObserver

vi.mock('../../renderer/stores/providerReadinessStore', () => ({
  useCateAgentReady: () => 'ok',
  useCodingReadiness: () => ({ kind: 'ok', message: '' }),
  useProvidersLoaded: () => true,
}))

import { CateAgentSidebarView } from './CateAgentSidebarView'
import { useChatsStore } from '../../renderer/stores/chatsStore'
import { useCateAgentStore } from './cateAgentStore'
import { useCodingStore } from './codingStore'
import { orchestratorPanelId } from './cateAgentSession'
import { useAppStore } from '../../renderer/stores/appStore'
import { useStatusStore } from '../../renderer/stores/statusStore'
import { endChatDrag, useChatDragState } from '../../renderer/drag/chatDragState'

const ROOT = '/root'
let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
    projectChatsLoad: vi.fn().mockResolvedValue([]),
    projectChatsSave: vi.fn(),
    gitIsRepo: vi.fn().mockResolvedValue(false),
    gitLsFiles: vi.fn().mockResolvedValue([]),
    gitStatus: vi.fn().mockResolvedValue({ files: [], current: '', ahead: 0, behind: 0 }),
    gitWorktreeList: vi.fn().mockResolvedValue([]),
    gitBranchList: vi.fn().mockResolvedValue({ current: '', branches: [] }),
    onFsWatchEvent: vi.fn().mockReturnValue(() => {}),
    onGitBranchUpdate: vi.fn().mockReturnValue(() => {}),
    fsWatchStart: vi.fn().mockResolvedValue(undefined),
    fsWatchStop: vi.fn().mockResolvedValue(undefined),
    agentListModels: vi.fn().mockResolvedValue([]),
    agentCreate: vi.fn().mockResolvedValue({ ok: true }),
    agentGetCommands: vi.fn().mockResolvedValue([]),
    agentGetSessionStats: vi.fn().mockResolvedValue({
      userMessages: 0, assistantMessages: 0, toolCalls: 0, toolResults: 0, totalMessages: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0,
    }),
    agentGetState: vi.fn().mockResolvedValue({
      model: null, thinkingLevel: 'medium', isStreaming: false, isCompacting: false,
      steeringMode: 'all', followUpMode: 'all', autoCompactionEnabled: true,
      messageCount: 0, pendingMessageCount: 0,
    }),
    agentGetForkMessages: vi.fn().mockResolvedValue([]),
  }
  useChatsStore.setState({ chatsByRoot: { [ROOT]: [] }, loadedRoots: { [ROOT]: true } })
  useCateAgentStore.setState({ byWs: {} })
  useCodingStore.setState({ panels: {} })
  useAppStore.setState({ workspaces: [], selectedWorkspaceId: undefined } as never)
  useStatusStore.setState({ workspaces: {} })
  endChatDrag()
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useChatsStore.setState({ chatsByRoot: {}, loadedRoots: {} })
  useCateAgentStore.setState({ byWs: {} })
  useCodingStore.setState({ panels: {} })
  useAppStore.setState({ workspaces: [], selectedWorkspaceId: undefined } as never)
  useStatusStore.setState({ workspaces: {} })
  endChatDrag()
  vi.clearAllMocks()
})

describe('CateAgentSidebarView', () => {
  it('renders one shared Cate Agent transcript for the active chat', () => {
    const chat = useChatsStore.getState().createChat(ROOT, 'Chat')
    useChatsStore.getState().appendMessage(ROOT, chat.id, {
      id: 'm1', role: 'user', ts: Date.now(), kind: 'text', text: 'one agent transcript',
    })
    useCateAgentStore.getState().setActiveChat('ws1', chat.id)
    const panelId = orchestratorPanelId(chat.id)
    useCodingStore.getState().init(panelId)
    useCodingStore.getState().setStats(panelId, {
      userMessages: 1,
      assistantMessages: 1,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: 2,
      tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
      cost: 0.01,
      contextUsage: { tokens: 150, contextWindow: 1_000, percent: 15 },
    })

    act(() => root.render(<CateAgentSidebarView wsId="ws1" rootPath={ROOT} />))

    expect(host.textContent).toContain('one agent transcript')
    expect(host.querySelector('textarea')).toBeTruthy()
    expect(host.querySelector('button[aria-label="Attach image"]')).toBeTruthy()
    expect(host.querySelector('button[aria-label^="Reasoning effort:"]')).toBeTruthy()
    expect(host.querySelector('button[aria-label="Toggle plan mode"]')).toBeTruthy()
    expect(host.querySelector('button[aria-label="Compact context"]')).toBeTruthy()
    expect(host.querySelector('button[aria-label="Conversation stats"]')).toBeTruthy()
  })

  it('creates the single chat type directly from the new-chat button', () => {
    act(() => root.render(<CateAgentSidebarView wsId="ws1" rootPath={ROOT} />))
    const plus = host.querySelector('button[title="New chat"]') as HTMLButtonElement
    act(() => plus.click())

    expect(useChatsStore.getState().getChats(ROOT)).toHaveLength(1)
    expect(document.body.textContent).not.toContain('New coding chat')
    expect(document.body.textContent).not.toContain('New loop chat')
  })

  it('renders only sidebar-owned chats when a panel owns another chat', () => {
    const sidebarChat = useChatsStore.getState().createChat(ROOT, 'Sidebar only')
    const panelChat = useChatsStore.getState().createChat(ROOT, 'Panel only', 'agent-panel-1')
    useChatsStore.getState().appendMessage(ROOT, panelChat.id, {
      id: 'panel-message',
      role: 'user',
      ts: Date.now(),
      kind: 'text',
      text: 'must not mirror into the sidebar',
    })
    useCateAgentStore.getState().setActiveChat('ws1', panelChat.id)

    act(() => root.render(<CateAgentSidebarView wsId="ws1" rootPath={ROOT} />))

    expect(host.textContent).toContain(sidebarChat.title)
    expect(host.textContent).not.toContain(panelChat.title)
    expect(host.textContent).not.toContain('must not mirror into the sidebar')
    expect(useCateAgentStore.getState().get('ws1').activeChatId).toBe(sidebarChat.id)
  })

  it('previews a panel chat as a ghost tab when it is dragged over the sidebar', () => {
    const panelChat = useChatsStore.getState().createChat(ROOT, 'Move me here', 'agent-panel-1')
    useChatDragState.setState({
      active: { chat: panelChat, rootPath: ROOT, sourceHostPanelId: 'agent-panel-1' },
      destinationHostPanelId: null,
    })

    act(() => root.render(<CateAgentSidebarView wsId="ws1" rootPath={ROOT} />))

    const ghost = host.querySelector('[data-chat-drop-ghost]')
    expect(ghost?.textContent).toContain('Move me here')
    expect(host.querySelectorAll('[data-chat-drop-ghost]')).toHaveLength(1)
  })

  it('hides the duplicate plan/iteration heading and shimmers running terminal chips', () => {
    const chat = useChatsStore.getState().createChat(ROOT, 'Engineering task')
    useChatsStore.getState().appendMessage(ROOT, chat.id, {
      id: 'plan-1',
      role: 'agent',
      ts: Date.now(),
      kind: 'plan',
      goal: 'duplicate plan should stay hidden',
      check: 'duplicate check should stay hidden',
    })
    useChatsStore.getState().appendMessage(ROOT, chat.id, {
      id: 'attempts-1',
      role: 'agent',
      ts: Date.now(),
      kind: 'attempts',
      round: 1,
      iterations: [{
        id: 'iteration-1',
        todoId: chat.id,
        round: 1,
        worktreeId: 'worktree-1',
        branch: 'cate/iteration-1',
        status: 'running',
        createdAt: Date.now(),
        agents: [{ agent: 'coding agent', terminalId: 'terminal-1', kind: 'work' }],
      }],
    })
    useCateAgentStore.getState().setActiveChat('ws1', chat.id)
    useAppStore.setState({
      workspaces: [{
        id: 'ws1',
        rootPath: ROOT,
        panels: { 'terminal-1': { id: 'terminal-1', type: 'terminal', title: 'README agent' } },
        worktrees: [],
      }],
      selectedWorkspaceId: 'ws1',
    } as never)
    useStatusStore.setState({
      workspaces: {
        ws1: {
          terminals: {
            'terminal-1': {
              activity: { type: 'running', processName: 'codex' },
              agentState: 'running',
              agentName: 'Codex',
              agentPresent: true,
              listeningPorts: [],
              cwd: ROOT,
            },
          },
        },
      },
    })

    act(() => root.render(<CateAgentSidebarView wsId="ws1" rootPath={ROOT} />))

    expect(host.textContent).not.toContain('Iterating')
    expect(host.textContent).not.toContain('Loop')
    expect(host.textContent).not.toContain('duplicate plan should stay hidden')
    expect(host.querySelector('.animate-spin')).toBeNull()
    const chip = host.querySelector('button[title="Jump to README agent"]')
    expect(chip?.querySelector('.cate-notif-pulse')).toBeTruthy()
  })
})
