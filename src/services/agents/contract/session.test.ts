import { describe, expect, it } from 'vitest'
import { AGENTS } from './registry'
import { agentAttentionNotification, openTerminalAgent } from './session'

describe('openTerminalAgent', () => {
  // The same rule for every CLI: open as soon as its command runs in the
  // terminal, whether or not its hooks speak before the first prompt.
  for (const agent of AGENTS) {
    it(`${agent.displayName}: \`${agent.runners.terminal.command}\` is open before any hook`, () => {
      expect(openTerminalAgent({ type: 'running', processName: agent.runners.terminal.command }, null, false)).toBe(agent)
    })

    it(`${agent.displayName}: a hook-reported agent is open whatever runs in the foreground`, () => {
      expect(openTerminalAgent({ type: 'running', processName: 'tmux' }, agent.id, true)).toBe(agent)
    })
  }

  it('Hermes runs as python3, so only its hook opens it', () => {
    expect(openTerminalAgent({ type: 'running', processName: 'python3' }, null, false)).toBeNull()
    expect(openTerminalAgent({ type: 'running', processName: 'python3' }, 'hermes', true)?.id).toBe('hermes')
  })

  it('a plain shell or another program is not an agent', () => {
    expect(openTerminalAgent({ type: 'idle' }, null, false)).toBeNull()
    expect(openTerminalAgent({ type: 'running', processName: 'vim' }, null, false)).toBeNull()
  })

  it('an exited agent is not open even though its id is kept for the footer', () => {
    expect(openTerminalAgent({ type: 'idle' }, 'codex', false)).toBeNull()
  })
})

describe('agentAttentionNotification', () => {
  it('says what a blocked agent asks for, or that it waits for input', () => {
    expect(agentAttentionNotification({ panelId: 'p', agentName: 'Codex', permission: 'rm -rf build' })).toEqual({
      kind: 'agent.needsPermission', panelId: 'p', title: 'Codex needs permission', body: 'rm -rf build',
    })
    expect(agentAttentionNotification({ panelId: 'p', agentName: null })).toEqual({
      kind: 'agent.needsInput', panelId: 'p', title: 'Agent needs input', body: 'Agent is waiting for your response.',
    })
  })
})
