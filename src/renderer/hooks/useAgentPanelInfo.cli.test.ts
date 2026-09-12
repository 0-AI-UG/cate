import { describe, expect, it, vi } from 'vitest'
import type { StatusStore } from '../stores/statusStore'

vi.mock('../lib/terminal/terminalRegistry', () => ({
  terminalRegistry: { panelIdForPty: (id: string) => id === 'pty-1' ? 'terminal-1' : null },
}))

import { selectCliAgentByPanel, selectCliAgentOpenByPanel } from './useAgentPanelInfo'

function status(agentPresent: boolean, processName: string | null): StatusStore {
  return {
    workspaces: {
      ws: {
        terminals: {
          'pty-1': {
            activity: { type: 'running', processName },
            agentState: 'notRunning',
            agentName: null,
            agentPresent,
            listeningPorts: [],
            cwd: '',
          },
        },
      },
    },
  } as unknown as StatusStore
}

describe('terminal CLI availability', () => {
  it('recognizes a canonical agent process before hook presence settles', () => {
    expect(selectCliAgentOpenByPanel(status(false, 'codex'), 'ws')).toEqual({ 'terminal-1': true })
  })

  it('uses hook-confirmed presence even when process activity has no name', () => {
    expect(selectCliAgentOpenByPanel(status(true, null), 'ws')).toEqual({ 'terminal-1': true })
  })

  it('does not classify an ordinary foreground process as an agent', () => {
    expect(selectCliAgentOpenByPanel(status(false, 'npm'), 'ws')).toEqual({ 'terminal-1': false })
  })

  it('returns the canonical agent id used to gate native prompt context', () => {
    expect(selectCliAgentByPanel(status(false, 'codex'), 'ws')).toEqual({ 'terminal-1': 'codex' })
    expect(selectCliAgentByPanel(status(false, 'cursor-agent'), 'ws')).toEqual({ 'terminal-1': 'cursor' })
  })
})
