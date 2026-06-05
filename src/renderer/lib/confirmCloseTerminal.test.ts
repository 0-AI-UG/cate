import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { PanelState } from '../../shared/types'

// Mock the registry (heavy xterm deps) and status store so we can drive the
// panelId → ptyId → workspace → activity lookup the helper performs. Terminal
// identity (panelId<->ptyId<->workspaceId) is now owned by the registry bimap.
const ptyIdForPanel = vi.fn<(panelId: string) => string | null>()
const ptyWorkspace = { map: {} as Record<string, string> }
vi.mock('./terminal/terminalRegistry', () => ({
  terminalRegistry: {
    ptyIdForPanel: (id: string) => ptyIdForPanel(id),
    workspaceIdForPty: (ptyId: string) => ptyWorkspace.map[ptyId],
  },
}))

const statusState = {
  workspaces: {} as Record<string, { terminalActivity: Record<string, unknown> }>,
}
vi.mock('../stores/statusStore', () => ({
  useStatusStore: { getState: () => statusState },
}))

import { confirmCloseRunningTerminals } from './confirmCloseTerminal'

function terminalPanel(id: string): PanelState {
  return { id, type: 'terminal', title: id } as unknown as PanelState
}

describe('confirmCloseRunningTerminals', () => {
  const confirmCloseTerminal = vi.fn()

  beforeEach(() => {
    ptyIdForPanel.mockReset()
    confirmCloseTerminal.mockReset()
    ptyWorkspace.map = {}
    statusState.workspaces = {}
    ;(globalThis as unknown as { window: { electronAPI: unknown } }).window = {
      electronAPI: { confirmCloseTerminal },
    }
  })

  it('proceeds without prompting when no terminal is running', async () => {
    ptyIdForPanel.mockReturnValue('pty-1')
    ptyWorkspace.map = { 'pty-1': 'ws-1' }
    statusState.workspaces = { 'ws-1': { terminalActivity: { 'pty-1': { type: 'idle' } } } }

    const ok = await confirmCloseRunningTerminals([terminalPanel('t1')])
    expect(ok).toBe(true)
    expect(confirmCloseTerminal).not.toHaveBeenCalled()
  })

  it('ignores non-terminal panels', async () => {
    const editor = { id: 'e1', type: 'editor', title: 'e1' } as unknown as PanelState
    const ok = await confirmCloseRunningTerminals([editor])
    expect(ok).toBe(true)
    expect(ptyIdForPanel).not.toHaveBeenCalled()
    expect(confirmCloseTerminal).not.toHaveBeenCalled()
  })

  it('prompts with the process name for a single running terminal and honours Close', async () => {
    ptyIdForPanel.mockReturnValue('pty-1')
    ptyWorkspace.map = { 'pty-1': 'ws-1' }
    statusState.workspaces = {
      'ws-1': { terminalActivity: { 'pty-1': { type: 'running', processName: 'vim' } } },
    }
    confirmCloseTerminal.mockResolvedValue('close')

    const ok = await confirmCloseRunningTerminals([terminalPanel('t1')])
    expect(ok).toBe(true)
    expect(confirmCloseTerminal).toHaveBeenCalledWith({ count: 1, processName: 'vim' })
  })

  it('returns false when the user cancels', async () => {
    ptyIdForPanel.mockReturnValue('pty-1')
    ptyWorkspace.map = { 'pty-1': 'ws-1' }
    statusState.workspaces = {
      'ws-1': { terminalActivity: { 'pty-1': { type: 'running', processName: 'npm' } } },
    }
    confirmCloseTerminal.mockResolvedValue('cancel')

    const ok = await confirmCloseRunningTerminals([terminalPanel('t1')])
    expect(ok).toBe(false)
  })

  it('passes a null processName when multiple terminals are running', async () => {
    ptyIdForPanel.mockImplementation((id: string) => `pty-${id}`)
    ptyWorkspace.map = { 'pty-t1': 'ws-1', 'pty-t2': 'ws-1' }
    statusState.workspaces = {
      'ws-1': {
        terminalActivity: {
          'pty-t1': { type: 'running', processName: 'vim' },
          'pty-t2': { type: 'running', processName: 'npm' },
        },
      },
    }
    confirmCloseTerminal.mockResolvedValue('close')

    const ok = await confirmCloseRunningTerminals([terminalPanel('t1'), terminalPanel('t2')])
    expect(ok).toBe(true)
    expect(confirmCloseTerminal).toHaveBeenCalledWith({ count: 2, processName: null })
  })
})
