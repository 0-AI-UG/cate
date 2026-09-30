import { describe, expect, it } from 'vitest'
import type { PanelAgentState } from '../contract'
import { agentPanelInfo, agentPanelTitle, isAgentFallbackTitle } from './panelInfo'

const state = (patch: Partial<PanelAgentState> = {}): PanelAgentState => ({
  panelId: 'p1', runner: 'terminal', agentId: 'claude-code', agentName: 'Claude Code', status: 'waitingForInput',
  present: true, canReceivePrompt: true, session: null, ...patch,
})

describe('agentPanelInfo', () => {
  it('names a present terminal agent with its logo', () => {
    const info = agentPanelInfo(state())
    expect(info).toMatchObject({ status: 'waitingForInput', runner: 'terminal', name: 'Claude Code' })
    expect(info.logo).toEqual(expect.any(String))
  })

  it('drops name and logo once the CLI exited but keeps the status', () => {
    expect(agentPanelInfo(state({ present: false, status: 'finished' }))).toEqual({
      status: 'finished', runner: 'terminal', name: null, logo: null,
    })
  })

  it('falls back to T3 Code for a chat without a provider and marks a disconnected one', () => {
    expect(agentPanelInfo(state({ runner: 't3', agentId: null, agentName: null }))).toMatchObject({ name: 'T3 Code', logo: null })
    expect(agentPanelInfo(state({ runner: 't3', present: false })).name).toBe('Claude Code (disconnected)')
  })
})

describe('agent panel titles', () => {
  it('recognizes fallback titles', () => {
    expect(isAgentFallbackTitle('Terminal')).toBe(true)
    expect(isAgentFallbackTitle('Terminal 3')).toBe(true)
    expect(isAgentFallbackTitle('Codex')).toBe(true)
    expect(isAgentFallbackTitle('Fix the login bug')).toBe(false)
  })

  it('shows the open agent name in place of a fallback title only', () => {
    expect(agentPanelTitle('Terminal 2', state())).toBe('Claude Code')
    expect(agentPanelTitle('Fix the login bug', state())).toBe('Fix the login bug')
    expect(agentPanelTitle('Terminal 2', state({ present: false }))).toBe('Terminal 2')
    expect(agentPanelTitle('Terminal 2', undefined)).toBe('Terminal 2')
  })
})
