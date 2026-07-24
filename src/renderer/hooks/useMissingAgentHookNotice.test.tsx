import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { useMissingAgentHookNotice } from './useMissingAgentHookNotice'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const state = vi.hoisted(() => ({
  status: {
    workspaces: {
      'workspace-1': {
        terminals: {
          'pty-1': {
            activity: { type: 'running', processName: 'codex' },
            agentPresent: false,
          },
        },
      },
    },
  },
  settings: { agentHookInjection: {} },
}))

vi.mock('../stores/statusStore', () => ({
  useStatusStore: (selector: (value: typeof state.status) => unknown) => selector(state.status),
}))
vi.mock('../stores/settingsStore', () => ({
  useSettingsStore: (selector: (value: typeof state.settings) => unknown) => selector(state.settings),
}))
vi.mock('../lib/terminal/terminalRegistry', () => ({
  terminalRegistry: { ptyIdForPanel: () => 'pty-1' },
}))

let root: Root
let host: HTMLDivElement
let observed: string | null = null

function Harness({ checkout }: { checkout: string }) {
  observed = useMissingAgentHookNotice('workspace-1', 'panel-1', checkout)
  return null
}

beforeEach(() => {
  observed = null
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
    agentHooksInspect: vi.fn().mockResolvedValue([
      { agentId: 'codex', displayName: 'Codex', folderPresent: true, injected: false },
    ]),
  }
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.clearAllMocks()
})

describe('useMissingAgentHookNotice worktree inspection', () => {
  it('checks hook installation in the terminal worktree rather than the base workspace', async () => {
    const worktree = '/repo/.cate/worktrees/feature'
    await act(async () => {
      root.render(<Harness checkout={worktree} />)
      await Promise.resolve()
    })

    expect(window.electronAPI.agentHooksInspect).toHaveBeenCalledWith(worktree)
    expect(observed).toBe('Codex')
  })
})
