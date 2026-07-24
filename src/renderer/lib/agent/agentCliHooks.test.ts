// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AgentCliHookError,
  evaluateAgentCliHooks,
  inspectAgentCliHooks,
  resolveDriverAgentCli,
} from './agentCliHooks'

const inspect = vi.fn()

beforeEach(() => {
  inspect.mockReset()
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { agentHooksInspect: inspect },
  })
})

describe('agent CLI hook readiness', () => {
  it('exposes the Auto-without-folder state for settings consumers', async () => {
    inspect.mockResolvedValue([])
    const [state] = await inspectAgentCliHooks('/repo')

    expect(evaluateAgentCliHooks(state)).toEqual({
      mode: 'auto',
      ready: false,
      autoSkipped: true,
    })
    expect(evaluateAgentCliHooks(state, { 'claude-code': 'on' })).toEqual({
      mode: 'on',
      ready: true,
      autoSkipped: false,
    })
  })

  it('uses registry order instead of inspection response order', async () => {
    inspect.mockResolvedValue([
      { agentId: 'codex', displayName: 'Codex', folderPresent: true, injected: true },
      { agentId: 'claude-code', displayName: 'Claude Code', folderPresent: true, injected: true },
    ])

    const states = await inspectAgentCliHooks('/repo')
    expect(states.filter((state) => state.injected).map((state) => state.agent.id)).toEqual([
      'claude-code',
      'codex',
    ])
    await expect(resolveDriverAgentCli('/repo', '')).resolves.toMatchObject({
      id: 'claude-code',
      command: 'claude',
    })
  })

  it('does not fall back when the configured CLI lacks hooks', async () => {
    inspect.mockResolvedValue([
      { agentId: 'claude-code', displayName: 'Claude Code', folderPresent: true, injected: true },
      { agentId: 'codex', displayName: 'Codex', folderPresent: false, injected: false },
    ])

    await expect(resolveDriverAgentCli('/repo', 'codex')).rejects.toMatchObject({
      name: 'AgentCliHookError',
      code: 'preferred-not-ready',
      settingsSection: 'agent hooks',
    } satisfies Partial<AgentCliHookError>)
  })

  it('fails automatic selection when no CLI is hook-ready', async () => {
    inspect.mockResolvedValue([])
    await expect(resolveDriverAgentCli('/repo', '')).rejects.toMatchObject({
      code: 'none-ready',
    })
  })

  it('treats an On override as ready before the first worktree terminal is created', async () => {
    inspect.mockResolvedValue([])
    await expect(resolveDriverAgentCli('/repo/worktree', 'codex', {
      hookConfig: { codex: 'on' },
    })).resolves.toMatchObject({ id: 'codex', command: 'codex' })
  })

  it('uses the base checkout as the Auto signal for a fresh worktree', async () => {
    inspect.mockImplementation(async (locator: string) =>
      locator === '/repo'
        ? [{ agentId: 'codex', displayName: 'Codex', folderPresent: true, injected: true }]
        : [],
    )
    await expect(resolveDriverAgentCli('/repo/worktree', '', {
      fallbackLocator: '/repo',
    })).resolves.toMatchObject({ id: 'codex', command: 'codex' })
  })
})
