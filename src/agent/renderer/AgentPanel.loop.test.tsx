// Coverage for AgentPanel's additive loop-chat branch. The panel hosts N coding
// chats (CodingChatView) and can also host a loop chat (LoopChatView): exactly
// one is "active" in the body. This pins the body dispatch (coding by default,
// loop once activeLoopChatId is set via the "+" chooser) and that the two never
// render at once. Both leaf views are stubbed so the test is about the panel's
// own routing, not their internals. Mocking style follows CodingChatView.test.tsx.

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Body leaves stubbed to unambiguous markers — the test asserts which one the
// panel routes to, never how they render.
vi.mock('./CodingChatView', () => ({
  CodingChatView: () => <div data-testid="coding-body">CODING</div>,
}))
// LoopChatView is loaded via React.lazy(() => import('.../LoopChatView')); the
// lazy loader reads the module's default export, so the stub provides `default`.
vi.mock('../../renderer/cateAgent/LoopChatView', () => ({
  default: () => <div data-testid="loop-body">LOOP</div>,
}))

// The loop delete path dynamic-imports the controller (which transitively pulls
// the loop runtime); mock it so the test stays hermetic.
vi.mock('../../renderer/cateAgent/cateAgentController', () => ({
  cateAgentController: { closeChat: vi.fn().mockResolvedValue(undefined) },
}))

// The composer's worktree menu data comes from these hooks; inert stubs keep the
// git/fs IPC surface out of the mount path.
vi.mock('../../renderer/stores/useWorktrees', () => ({ useWorktrees: () => [] }))
vi.mock('../../renderer/stores/useWorktreeActions', () => ({
  useWorktreeActions: () => ({ createWorktree: vi.fn(), checkoutPr: vi.fn() }),
}))

// Keep the coding mount lifecycle inert: no durable chats to resolve, no pi spawn
// (beginAgentCreate:false makes createAgent bail before any IPC). The loop branch
// under test doesn't touch the registry at all.
vi.mock('./agentSessionRegistry', () => ({
  getAgentPanelSession: () => undefined,
  saveAgentPanelSession: vi.fn(),
  disposeAgentChats: vi.fn(),
  disposeCodingChat: vi.fn(),
  resolvePanelChats: () => ({ refs: [], toResume: [] }),
  beginAgentCreate: () => false,
  endAgentCreate: vi.fn(),
  createCodingChatSession: () => ({ chatId: 'c1', agentKey: 'k1', ready: Promise.resolve(false) }),
}))

import AgentPanel from './AgentPanel'
import { useAppStore } from '../../renderer/stores/appStore'
import { useChatsStore } from '../../renderer/stores/chatsStore'
import type { WorkspaceState, PanelState } from '../../shared/types'

const WS = 'ws-1'
const PANEL = 'panel-1'
const ROOT = '/root'

let host: HTMLDivElement
let root: Root

const flush = () => act(async () => { await Promise.resolve() })

const click = (el: Element) =>
  act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)

  ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
    agentListModels: vi.fn().mockResolvedValue([]),
    agentListSessions: vi.fn().mockResolvedValue([]),
    agentGetCommands: vi.fn().mockResolvedValue([]),
    agentGetState: vi.fn().mockResolvedValue(null),
    agentLoadSessionMessages: vi.fn().mockResolvedValue([]),
    projectChatsLoad: vi.fn().mockResolvedValue([]),
    projectChatsSave: vi.fn(),
  }

  useAppStore.setState({
    workspaces: [
      { id: WS, name: 'W', color: '#fff', rootPath: ROOT, panels: { [PANEL]: {} as PanelState } },
    ] as unknown as WorkspaceState[],
    selectedWorkspaceId: WS,
  })
  useChatsStore.setState({ chatsByRoot: {}, loadedRoots: {} })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useChatsStore.setState({ chatsByRoot: {}, loadedRoots: {} })
  vi.clearAllMocks()
})

describe('AgentPanel loop-chat branch', () => {
  it('renders the coding body by default (no loop chat active)', async () => {
    await act(async () => { root.render(<AgentPanel panelId={PANEL} workspaceId={WS} />) })
    await flush()

    expect(host.querySelector('[data-testid="coding-body"]')).toBeTruthy()
    expect(host.querySelector('[data-testid="loop-body"]')).toBeNull()
  })

  it('flips the body to the loop view when "New loop chat" is chosen, and back', async () => {
    await act(async () => { root.render(<AgentPanel panelId={PANEL} workspaceId={WS} />) })
    await flush()

    // Open the "+" chooser, then pick "New loop chat".
    const plus = host.querySelector('button[aria-label="New chat"]')!
    click(plus)
    const loopItem = Array.from(host.querySelectorAll('button[role="menuitem"]')).find(
      (b) => b.textContent?.includes('New loop chat'),
    )!
    click(loopItem)
    await flush()

    // A loop chat was minted and set active; body is LoopChatView, not coding.
    expect(useChatsStore.getState().getChatsByMode(ROOT, 'loop')).toHaveLength(1)
    expect(host.querySelector('[data-testid="loop-body"]')).toBeTruthy()
    expect(host.querySelector('[data-testid="coding-body"]')).toBeNull()

    // The loop chat now shows in the sidebar's Loops section; deleting it flips
    // the body back to coding.
    const del = host.querySelector('button[aria-label="Delete loop chat"]')!
    click(del)
    await flush()

    expect(host.querySelector('[data-testid="coding-body"]')).toBeTruthy()
    expect(host.querySelector('[data-testid="loop-body"]')).toBeNull()
  })
})
