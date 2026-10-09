import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AgentCliHookError,
  evaluateAgentCliHooks,
  inspectAgentCliHooks,
  resolveDriverAgent,
} from './readiness'

const inspect = vi.fn()

beforeEach(() => {
  inspect.mockReset()
})

describe('agent CLI hook readiness', () => {
  it('exposes the Auto-without-folder state for settings consumers', async () => {
    inspect.mockResolvedValue([])
    const [state] = await inspectAgentCliHooks(inspect, '/repo')

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

  it('Auto counts only the in-use signals the runtime injects on, never a profile-wide install', async () => {
    // Hermes' plugin is installed per profile, not per checkout: the runtime
    // still plants CATE_HERMES_HOOKS=0 on a plain terminal in Auto.
    inspect.mockResolvedValue([{ agentId: 'hermes', displayName: 'Hermes', folderPresent: false, injected: true }])
    const hermes = (await inspectAgentCliHooks(inspect, '/repo')).find((state) => state.agent.id === 'hermes')!
    expect(evaluateAgentCliHooks(hermes)).toEqual({ mode: 'auto', ready: false, autoSkipped: true })
  })

  it('uses registry order instead of inspection response order', async () => {
    inspect.mockResolvedValue([
      { agentId: 'codex', displayName: 'Codex', folderPresent: true, injected: true },
      { agentId: 'claude-code', displayName: 'Claude Code', folderPresent: true, injected: true },
    ])

    const states = await inspectAgentCliHooks(inspect, '/repo')
    expect(states.filter((state) => state.injected).map((state) => state.agent.id)).toEqual([
      'claude-code',
      'codex',
    ])
    await expect(resolveDriverAgent(inspect, '/repo', '')).resolves.toMatchObject({
      id: 'claude-code',
      runners: { terminal: { command: 'claude' } },
    })
  })

  it('does not fall back when the configured CLI lacks hooks', async () => {
    inspect.mockResolvedValue([
      { agentId: 'claude-code', displayName: 'Claude Code', folderPresent: true, injected: true },
      { agentId: 'codex', displayName: 'Codex', folderPresent: false, injected: false },
    ])

    await expect(resolveDriverAgent(inspect, '/repo', 'codex')).rejects.toMatchObject({
      name: 'AgentCliHookError',
      code: 'preferred-not-ready',
    } satisfies Partial<AgentCliHookError>)
  })

  it('fails automatic selection when no CLI is hook-ready', async () => {
    inspect.mockResolvedValue([])
    await expect(resolveDriverAgent(inspect, '/repo', '')).rejects.toMatchObject({
      code: 'none-ready',
    })
  })

  it('treats an On override as ready before the first worktree terminal is created', async () => {
    inspect.mockResolvedValue([])
    await expect(resolveDriverAgent(inspect, '/repo/worktree', 'codex', {
      hookConfig: { codex: 'on' },
    })).resolves.toMatchObject({ id: 'codex', runners: { terminal: { command: 'codex' } } })
  })

  it('uses the base checkout as the Auto signal for a fresh worktree', async () => {
    inspect.mockImplementation(async (cwd: string) =>
      cwd === '/repo'
        ? [{ agentId: 'codex', displayName: 'Codex', folderPresent: true, injected: true }]
        : [],
    )
    await expect(resolveDriverAgent(inspect, '/repo/worktree', '', {
      fallbackCwd: '/repo',
    })).resolves.toMatchObject({ id: 'codex', runners: { terminal: { command: 'codex' } } })
  })
})
