import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

// Provider gate: pretend a provider is connected so the body renders. The coding
// path also reads the agent readiness selectors, so stub them 'ok' too.
vi.mock('../../renderer/stores/providerReadinessStore', () => ({
  useCateAgentReady: () => 'ok',
  useCodingReadiness: () => ({ kind: 'ok' }),
  useProvidersLoaded: () => true,
}))

import { CateAgentSidebarView } from './CateAgentSidebarView'
import { useChatsStore } from '../../renderer/stores/chatsStore'
import { useCateAgentStore } from './cateAgentStore'
import { useCodingStore } from './codingStore'

const ROOT = '/root'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  // ChatThread (coding transcript) uses scrollTo + IntersectionObserver; the loop
  // scroll rail uses CSS.escape — both missing in this environment.
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = vi.fn()
  if (typeof CSS === 'undefined') {
    ;(globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS = { escape: (s) => s }
  } else if (!CSS.escape) {
    CSS.escape = (s) => s
  }
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
  // chatsStore.loadChats fires an IPC call on mount (projectChatsLoad); the
  // git-status join behind CateAgentThread/useWorktrees also touches the git +
  // fs-watch IPC surface on mount, and the coding path polls pi — stub the whole
  // surface the render path touches to avoid throwing on an undefined method.
  ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
    projectChatsLoad: vi.fn().mockResolvedValue([]),
    projectChatsSave: vi.fn(),
    gitIsRepo: vi.fn().mockResolvedValue(false),
    gitLsFiles: vi.fn().mockResolvedValue([]),
    gitStatus: vi.fn().mockResolvedValue({ files: [], current: '', ahead: 0, behind: 0 }),
    gitWorktreeList: vi.fn().mockResolvedValue([]),
    onFsWatchEvent: vi.fn().mockReturnValue(() => {}),
    onGitBranchUpdate: vi.fn().mockReturnValue(() => {}),
    fsWatchStart: vi.fn().mockResolvedValue(undefined),
    fsWatchStop: vi.fn().mockResolvedValue(undefined),
    // The composer fetches the model list and branch list on mount.
    agentListModels: vi.fn().mockResolvedValue([]),
    gitBranchList: vi.fn().mockResolvedValue({ current: '', branches: [] }),
    // Coding host data + pi polling.
    agentGetCommands: vi.fn().mockResolvedValue([]),
    agentGetSessionStats: vi.fn().mockResolvedValue(null),
    agentGetState: vi.fn().mockResolvedValue(null),
    agentGetForkMessages: vi.fn().mockResolvedValue([]),
  }
  useChatsStore.setState({ chatsByRoot: {}, loadedRoots: {} })
  useCateAgentStore.setState({ byWs: {} })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useChatsStore.setState({ chatsByRoot: {}, loadedRoots: {} })
  useCateAgentStore.setState({ byWs: {} })
  vi.clearAllMocks()
})

describe('CateAgentSidebarView', () => {
  it('mounts with an empty feed without throwing', () => {
    act(() => {
      root.render(<CateAgentSidebarView wsId="ws1" rootPath="/root" />)
    })
    // The default ws1 state has observerView: false, activeChatId: '', so
    // CateAgentThread falls through to the sidebar's own logo empty state.
    expect(host.textContent).toContain('Cate Agent')
    expect(host.textContent).toContain('Runs parallel loops')
  })

  it('renders the coding body (ChatThread + ChatComposer) for a coding active chat', () => {
    // Seed a live coding chat: durable record + its useCodingStore slice.
    const AGENT_KEY = 'agent-sidebar-coding'
    useCodingStore.getState().init(AGENT_KEY)
    useCodingStore.getState().setModel(AGENT_KEY, { provider: 'anthropic', model: 'claude' })
    useCodingStore.getState().appendUser(AGENT_KEY, 'hello from a coding chat')
    const chat = useChatsStore.getState().createCodingChat(ROOT, {
      agentKey: AGENT_KEY,
      sessionFile: null,
      title: 'Coding',
    })
    useCateAgentStore.getState().setActiveChat('ws1', chat.id)

    act(() => {
      root.render(<CateAgentSidebarView wsId="ws1" rootPath={ROOT} />)
    })

    // The coding transcript (ChatThread) rendered the seeded pi message and a
    // composer textarea — and the loop empty state did NOT render.
    expect(host.textContent).toContain('hello from a coding chat')
    expect(host.querySelector('textarea')).toBeTruthy()
    expect(host.textContent).not.toContain('Runs parallel loops')

    useCodingStore.getState().dispose(AGENT_KEY)
  })

  it('renders the loop body for a loop active chat', () => {
    const chat = useChatsStore.getState().createChat(ROOT, 'Loop')
    useChatsStore.getState().appendMessage(ROOT, chat.id, {
      id: 'm1',
      role: 'user',
      ts: Date.now(),
      kind: 'text',
      text: 'a loop message',
    })
    useCateAgentStore.getState().setActiveChat('ws1', chat.id)

    act(() => {
      root.render(<CateAgentSidebarView wsId="ws1" rootPath={ROOT} />)
    })

    // The loop transcript (CateAgentThread → LoopTranscript) rendered the loop
    // message + the loop composer.
    expect(host.textContent).toContain('a loop message')
    expect(host.querySelector('textarea')).toBeTruthy()
  })

  it('offers a Coding / Loop chooser on the new-chat control', () => {
    act(() => {
      root.render(<CateAgentSidebarView wsId="ws1" rootPath={ROOT} />)
    })

    const plus = host.querySelector('button[title="New chat"]') as HTMLButtonElement | null
    expect(plus).toBeTruthy()
    act(() => {
      plus!.click()
    })

    // The chooser is portalled to <body> (see the overflow-clip test below), so
    // assert against the document rather than just the mount host.
    expect(document.body.textContent).toContain('New coding chat')
    expect(document.body.textContent).toContain('New loop chat')
  })

  it('renders the chooser menu outside the overflow-clipping tab strip', () => {
    act(() => {
      root.render(<CateAgentSidebarView wsId="ws1" rootPath={ROOT} />)
    })

    const plus = host.querySelector('button[title="New chat"]') as HTMLButtonElement | null
    expect(plus).toBeTruthy()
    act(() => {
      plus!.click()
    })

    // The chooser must escape the tab strip's overflow clip: find the menu (by its
    // "New coding chat" item) and the strip (the .overflow-x-auto element), then
    // assert the menu is NOT nested inside the strip. Without the portal fix the
    // menu is a strip descendant and this fails; the layout itself is untestable
    // in jsdom, so we pin the DOM-structure contract instead.
    const menus = Array.from(document.body.querySelectorAll('[role="menu"]'))
    const menu = menus.find((m) => m.textContent?.includes('New coding chat')) ?? null
    expect(menu).toBeTruthy()
    const strip = document.body.querySelector('.overflow-x-auto')
    expect(strip).toBeTruthy()
    expect(strip!.contains(menu)).toBe(false)
  })
})
