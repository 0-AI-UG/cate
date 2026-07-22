// Coverage for the CateAgentPanel sidebar's coding list now that it lists DURABLE
// coding chats (chatsStore) rather than pi's on-disk session history. Mounts the
// real panel + real CateAgentPanelSidebar + real session registry so the resolve →
// openChats → durable-title render path is exercised end to end: a live coding
// chat (its useCodingStore slice already seeded, so it's adopted by reference with
// no pi spawn) shows its durable title, and the row re-renders when that durable
// title changes. Only the leaf body views are stubbed. Mocking style follows
// CateAgentPanel.loop.test.tsx.

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Body leaves stubbed — this test is about the sidebar list, not the transcript.
vi.mock('./CodingChatView', () => ({
  CodingChatView: () => <div data-testid="coding-body">CODING</div>,
}))
vi.mock('./LoopChatView', () => ({
  default: () => <div data-testid="loop-body">LOOP</div>,
}))

// Composer worktree/model menu data — inert stubs keep git/fs IPC out of mount.
vi.mock('../../renderer/stores/useWorktrees', () => ({ useWorktrees: () => [] }))
vi.mock('../../renderer/stores/useWorktreeActions', () => ({
  useWorktreeActions: () => ({ createWorktree: vi.fn(), checkoutPr: vi.fn() }),
}))

// NOTE: the session registry is deliberately NOT mocked — resolvePanelChats must
// run for real so the panel adopts the seeded durable chat into openChats.
import CateAgentPanel from './CateAgentPanel'
import { useAppStore } from '../../renderer/stores/appStore'
import { useChatsStore } from '../../renderer/stores/chatsStore'
import { useCodingStore } from './codingStore'
import { disposeCateAgentPanel } from './codingSessionRegistry'
import type { WorkspaceState, PanelState } from '../../shared/types'

const WS = 'ws-1'
const PANEL = 'panel-sidebar'
const ROOT = '/root'
const AGENT_KEY = 'k-alpha'

let host: HTMLDivElement
let root: Root

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)

  ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
    agentListModels: vi.fn().mockResolvedValue([]),
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
  disposeCateAgentPanel(PANEL)
  useCodingStore.getState().dispose(AGENT_KEY)
  useChatsStore.setState({ chatsByRoot: {}, loadedRoots: {} })
  vi.clearAllMocks()
})

describe('CateAgentPanel sidebar — durable coding list', () => {
  it('renders a durable coding chat title and updates when it changes', async () => {
    // Seed a LIVE coding chat: its useCodingStore slice exists, so resolvePanelChats
    // adopts it by reference (no pi spawn). createCodingChat marks the root loaded,
    // so the mount's loadChats is a no-op and never clobbers it.
    useCodingStore.getState().init(AGENT_KEY)
    const chat = useChatsStore.getState().createCodingChat(ROOT, {
      agentKey: AGENT_KEY,
      sessionFile: null,
      title: 'Alpha',
    })

    await act(async () => { root.render(<CateAgentPanel panelId={PANEL} workspaceId={WS} />) })
    await flush()

    // The sidebar row shows the durable title (not a pi-session recents entry).
    const row = host.querySelector('button[title="Alpha"]')
    expect(row).toBeTruthy()
    expect(row!.textContent).toContain('Alpha')

    // Renaming the durable chat re-renders the row live (the panel subscribes to
    // the chatsStore list, mirroring the write-back that keeps titles current).
    await act(async () => {
      useChatsStore.getState().updateCodingChat(ROOT, chat.id, { title: 'Renamed' })
    })
    await flush()

    expect(host.querySelector('button[title="Alpha"]')).toBeNull()
    expect(host.querySelector('button[title="Renamed"]')).toBeTruthy()
  })
})
