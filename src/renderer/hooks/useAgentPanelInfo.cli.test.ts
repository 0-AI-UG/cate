import { describe, expect, it, vi } from 'vitest'
import type { StatusStore } from '../stores/statusStore'
import type { AgentId } from '../../shared/agents'

vi.mock('../lib/terminal/terminalRegistry', () => ({
  terminalRegistry: { panelIdForPty: (id: string) => id === 'pty-1' ? 'terminal-1' : null },
}))

import { selectCliAgentByPanel, selectCliAgentOpenByPanel } from './useAgentPanelInfo'

// statusStore holds the open agent as the scan rule (openTerminalAgent) set
// it, so these selectors only read agentPresent/agentId.
function status(agentPresent: boolean, agentId: AgentId | null, processName: string | null = null): StatusStore {
  return {
    workspaces: {
      ws: {
        terminals: {
          'pty-1': {
            activity: { type: 'running', processName },
            agentState: 'notRunning',
            agentId,
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
  it('reads the open agent recorded for the terminal', () => {
    expect(selectCliAgentOpenByPanel(status(true, 'codex', 'codex'), 'ws')).toEqual({ 'terminal-1': true })
    expect(selectCliAgentOpenByPanel(status(true, 'hermes', 'python3'), 'ws')).toEqual({ 'terminal-1': true })
  })

  it('an exited agent keeps its id but is not open', () => {
    expect(selectCliAgentOpenByPanel(status(false, 'codex'), 'ws')).toEqual({ 'terminal-1': false })
    expect(selectCliAgentByPanel(status(false, 'codex'), 'ws')).toEqual({ 'terminal-1': null })
  })

  it('returns the canonical agent id used to gate native prompt context', () => {
    expect(selectCliAgentByPanel(status(true, 'codex'), 'ws')).toEqual({ 'terminal-1': 'codex' })
    expect(selectCliAgentByPanel(status(true, 'cursor'), 'ws')).toEqual({ 'terminal-1': 'cursor' })
  })
})
