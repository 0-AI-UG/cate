import { describe, expect, it } from 'vitest'
import type { PanelAgentState } from '@services/agents/contract'
import { agentPanelTitle, isAgentFallbackTitle } from '@services/agents/client'
import { agentPanelInfo } from './panelInfo'

const state = (patch: Partial<PanelAgentState> = {}): PanelAgentState => ({
  panelId: 'p1', agentId: 'claude-code', agentName: 'Claude Code', label: 'Claude Code', takesOverPanel: true, contextPolicy: null, status: 'waitingForInput',
  present: true, canReceivePrompt: true, session: null, ...patch,
})

describe('agentPanelInfo', () => {
  it('names a present terminal agent with its logo', () => {
    const info = agentPanelInfo(state())
    expect(info).toMatchObject({ status: 'waitingForInput', takesOverPanel: true, name: 'Claude Code' })
    expect(info.logo).toEqual(expect.any(String))
  })

  it('drops name and logo with the label but keeps the status', () => {
    expect(agentPanelInfo(state({ present: false, label: null, status: 'finished' }))).toEqual({
      status: 'finished', takesOverPanel: true, name: null, logo: null,
    })
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
