import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

// Provider gate: pretend a provider is connected so the body renders.
vi.mock('../stores/providerReadinessStore', () => ({ useCateAgentReady: () => 'ok' }))

import { CateAgentSidebarView } from './CateAgentSidebarView'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  // chatsStore.loadChats fires an IPC call on mount (projectChatsLoad); the
  // git-status join behind CateAgentThread/useWorktrees also touches the git +
  // fs-watch IPC surface on mount, so stub the whole surface the render path
  // touches to avoid throwing on an undefined electronAPI method.
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
  }
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.clearAllMocks()
})

describe('CateAgentSidebarView', () => {
  it('mounts with an empty feed without throwing', () => {
    act(() => {
      root.render(<CateAgentSidebarView wsId="ws1" rootPath="/root" />)
    })
    // The default ws1 state has observerView: false, activeChatId: '', so
    // CateAgentThread falls through to the EmptyState copy.
    expect(host.textContent).toContain('Runs parallel loops')
  })
})
