// Smoke test for ChatView — the mode dispatcher. Given a seeded chatsStore
// record it renders the right leaf: CodingChatView for a coding chat (backed by
// a live useAgentStore slice), the lazy LoopChatView for a loop chat. The loop
// leaf is mocked so the test never pulls the loop runtime (xterm). Mocking style
// follows CodingChatView.test.tsx / CateAgentSidebarView.test.tsx.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

// Provider gate: pretend a provider is connected + auth resolved so the coding
// composer isn't in an error state.
vi.mock('../stores/providerReadinessStore', () => ({
  useAgentReadiness: () => ({ kind: 'ok' }),
  useProvidersLoaded: () => true,
}))

// Stand in for the lazy loop leaf so the dynamic import resolves synchronously
// enough for the test and never drags in cateAgentController/xterm.
vi.mock('../cateAgent/LoopChatView', () => ({
  default: () => <div>loop-leaf-rendered</div>,
}))

import { ChatView } from './ChatView'
import { useChatsStore } from '../stores/chatsStore'
import { useAgentStore } from '../../agent/renderer/agentStore'

const ROOT = '/root'
const AGENT_KEY = 'agent-chatview-1'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  // ChatThread (inside CodingChatView) uses scrollTo + IntersectionObserver.
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = vi.fn()
  if (!('IntersectionObserver' in globalThis)) {
    ;(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
      takeRecords(): [] {
        return []
      }
    }
  }
  ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
    projectChatsSave: vi.fn().mockResolvedValue(undefined),
    // Coding composer + host data fetched on mount.
    agentListModels: vi.fn().mockResolvedValue([]),
    agentGetCommands: vi.fn().mockResolvedValue([]),
    agentGetSessionStats: vi.fn().mockResolvedValue(null),
    agentGetState: vi.fn().mockResolvedValue(null),
    agentGetForkMessages: vi.fn().mockResolvedValue([]),
    // useWorktrees git-status join touches this surface on mount.
    gitIsRepo: vi.fn().mockResolvedValue(false),
    gitLsFiles: vi.fn().mockResolvedValue([]),
    gitStatus: vi.fn().mockResolvedValue({ files: [], current: '', ahead: 0, behind: 0 }),
    gitWorktreeList: vi.fn().mockResolvedValue([]),
    onFsWatchEvent: vi.fn().mockReturnValue(() => {}),
    onGitBranchUpdate: vi.fn().mockReturnValue(() => {}),
    fsWatchStart: vi.fn().mockResolvedValue(undefined),
    fsWatchStop: vi.fn().mockResolvedValue(undefined),
  }
  useChatsStore.setState({ chatsByRoot: {}, loadedRoots: {} })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useAgentStore.getState().dispose(AGENT_KEY)
  useChatsStore.setState({ chatsByRoot: {}, loadedRoots: {} })
  vi.clearAllMocks()
})

describe('ChatView', () => {
  it('renders CodingChatView for a coding chat', () => {
    // Seed a live coding chat: durable record + its useAgentStore slice.
    useAgentStore.getState().init(AGENT_KEY)
    useAgentStore.getState().setModel(AGENT_KEY, { provider: 'anthropic', model: 'claude' })
    useAgentStore.getState().appendUser(AGENT_KEY, 'hello from a coding chat')
    const chat = useChatsStore.getState().createCodingChat(ROOT, {
      agentKey: AGENT_KEY,
      sessionFile: null,
      title: 'Coding',
    })

    act(() => {
      root.render(<ChatView chatId={chat.id} rootPath={ROOT} workspaceId="ws-1" surface="sidebar" />)
    })

    // The coding transcript rendered the seeded message + a composer textarea.
    expect(host.textContent).toContain('hello from a coding chat')
    expect(host.querySelector('textarea')).toBeTruthy()
    expect(host.textContent).not.toContain('loop-leaf-rendered')
  })

  it('renders the (lazy) LoopChatView for a loop chat', async () => {
    const chat = useChatsStore.getState().createChat(ROOT, 'Loop')

    await act(async () => {
      root.render(<ChatView chatId={chat.id} rootPath={ROOT} workspaceId="ws-1" surface="sidebar" />)
      // Let the lazy import + Suspense resolve.
      await Promise.resolve()
    })

    expect(host.textContent).toContain('loop-leaf-rendered')
  })
})
