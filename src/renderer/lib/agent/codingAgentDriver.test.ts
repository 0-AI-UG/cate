import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  app: {} as any,
  settings: { agentHookInjection: { ws: { codex: 'on' } } } as any,
  failure: undefined as string | undefined,
}))
const resolveDriverAgentCli = vi.hoisted(() => vi.fn())
const getOrCreate = vi.hoisted(() => vi.fn())
const submitTerminalText = vi.hoisted(() => vi.fn(async () => true))

vi.mock('../../stores/appStore', () => ({
  useAppStore: {
    getState: () => state.app,
    subscribe: vi.fn(() => () => {}),
  },
}))
vi.mock('../../stores/statusStore', () => ({
  useStatusStore: {
    getState: () => ({ workspaces: {} }),
    subscribe: vi.fn(() => () => {}),
  },
}))
vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: { getState: () => state.settings },
}))
vi.mock('../terminal/terminalRegistry', () => ({
  terminalRegistry: {
    getEntry: () => ({
      ptyId: 'pty-1',
      alive: true,
      terminal: {},
    }),
    getFailure: () => state.failure,
    getOrCreate,
    subscribeFailure: vi.fn(() => () => {}),
    terminate: vi.fn(),
  },
}))
vi.mock('../terminal/terminalBuffer', () => ({
  terminalBufferTail: () => 'worker output',
}))
vi.mock('../terminal/terminalDriver', () => ({ submitTerminalText }))
vi.mock('../workspace/canvasAccess', () => ({
  placementForBackgroundPanel: (_workspaceId: string, placementGroupId: string) => ({
    target: 'canvas',
    placementGroupId,
  }),
}))
vi.mock('../../stores/useWorktreeActions', () => ({
  createWorktreeForWorkspace: vi.fn(),
}))
vi.mock('./agentCliHooks', () => ({ resolveDriverAgentCli }))

import { AGENTS } from '../../../shared/agents'
import { codingAgentSnapshot, handleCodingAgentMethod } from './codingAgentDriver'

describe('codingAgentDriver mission integration', () => {
  beforeEach(() => {
    state.failure = undefined
    state.settings = { agentHookInjection: { ws: { codex: 'on' } } }
    const panels: Record<string, any> = {}
    state.app = {
      workspaces: [{
        id: 'ws',
        rootPath: '/repo',
        panels,
        worktrees: [],
      }],
      createTerminal: vi.fn((
        _workspaceId: string,
        _initialInput: unknown,
        _position: unknown,
        placement: { placementGroupId: string },
        cwd: string,
        launch: { runId: string; agentId: string; prompt: string; ownerPanelId: string },
      ) => {
        panels.worker = {
          id: 'worker',
          type: 'terminal',
          title: 'Terminal',
          cwd,
          placementGroupId: placement.placementGroupId,
          codingAgentLaunch: launch,
          codingAgentRun: {
            id: launch.runId,
            agentId: launch.agentId,
            panelId: 'worker',
            ownerPanelId: launch.ownerPanelId,
            prompt: launch.prompt,
            createdAt: 1,
          },
        }
        return 'worker'
      }),
      setPanelWorktreeId: vi.fn(),
      setPanelCodingAgentRun: vi.fn((_ws: string, panelId: string, run: unknown) => {
        panels[panelId].codingAgentRun = run
      }),
      updatePanelTitle: vi.fn(),
    }
    resolveDriverAgentCli.mockReset()
    resolveDriverAgentCli.mockResolvedValue(AGENTS.find((agent) => agent.id === 'codex'))
    getOrCreate.mockReset()
    getOrCreate.mockResolvedValue({ ptyId: 'pty-1', alive: true, terminal: {} })
    submitTerminalText.mockClear()
  })

  it('automatically selects a hook-ready canonical agent and starts its PTY headlessly', async () => {
    const outcome = await handleCodingAgentMethod(
      'ws',
      'supervisor-1',
      'cate.codingAgent.create',
      { prompt: 'Implement it' },
    )

    expect(outcome.ok).toBe(true)
    expect(resolveDriverAgentCli).toHaveBeenCalledWith('/repo', '', {
      fallbackLocator: '/repo',
      hookConfig: { codex: 'on' },
    })
    expect(state.app.createTerminal).toHaveBeenCalledWith(
      'ws',
      undefined,
      undefined,
      expect.objectContaining({ placementGroupId: 'coding-agent:primary' }),
      '/repo',
      expect.objectContaining({
        agentId: 'codex',
        ownerPanelId: 'supervisor-1',
        prompt: 'Implement it',
      }),
    )
    expect(getOrCreate).toHaveBeenCalledWith('worker', expect.objectContaining({
      workspaceId: 'ws',
      cwd: '/repo',
      codingAgentLaunch: expect.objectContaining({ ownerPanelId: 'supervisor-1' }),
    }))
  })

  it('rejects a non-ready explicit agent before creating a terminal', async () => {
    resolveDriverAgentCli.mockRejectedValue(new Error('Codex hooks are disabled'))

    const outcome = await handleCodingAgentMethod(
      'ws',
      'supervisor-1',
      'cate.codingAgent.create',
      { agentId: 'codex', prompt: 'Implement it' },
    )

    expect(outcome).toEqual({
      ok: false,
      error: 'agent-hooks-not-ready: Codex hooks are disabled',
    })
    expect(state.app.createTerminal).not.toHaveBeenCalled()
    expect(getOrCreate).not.toHaveBeenCalled()
  })

  it('isolates run lookup to the Cate Agent session that created it', async () => {
    await handleCodingAgentMethod(
      'ws',
      'supervisor-1',
      'cate.codingAgent.create',
      { agentId: 'codex', prompt: 'Implement it' },
    )
    const runId = state.app.workspaces[0].panels.worker.codingAgentRun.id

    expect(codingAgentSnapshot('ws', 'supervisor-1', runId)).not.toBeNull()
    expect(codingAgentSnapshot('ws', 'supervisor-2', runId)).toBeNull()
    await expect(handleCodingAgentMethod(
      'ws',
      'supervisor-2',
      'cate.codingAgent.inspect',
      { runId },
    )).resolves.toEqual({ ok: false, error: 'coding-agent-not-found' })
  })

  it('returns terminal startup failures as actionable mission diagnostics', async () => {
    state.failure = 'spawn codex ENOENT'

    const outcome = await handleCodingAgentMethod(
      'ws',
      'supervisor-1',
      'cate.codingAgent.create',
      { agentId: 'codex', prompt: 'Implement it' },
    )

    expect(outcome).toMatchObject({
      ok: true,
      result: {
        status: 'failed',
        failureReason: 'spawn codex ENOENT',
      },
    })
  })
})
