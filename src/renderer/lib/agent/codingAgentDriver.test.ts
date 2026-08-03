import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  app: {} as any,
  settings: { agentHookInjection: { ws: { codex: 'on' } } } as any,
  failure: null as string | null,
  terminalOutput: 'worker output',
  entry: { ptyId: 'pty-1', alive: true, terminal: {} } as any,
  status: { workspaces: {} } as any,
  appSubscribers: new Set<() => void>(),
  statusSubscribers: new Set<() => void>(),
  failureSubscribers: new Set<() => void>(),
}))
const resolveDriverAgentCli = vi.hoisted(() => vi.fn())
const getOrCreate = vi.hoisted(() => vi.fn())
const submitTerminalText = vi.hoisted(() => vi.fn(async () => true))
const terminate = vi.hoisted(() => vi.fn())
const createWorktreeForWorkspace = vi.hoisted(() => vi.fn())

vi.mock('../../stores/appStore', () => ({
  useAppStore: {
    getState: () => state.app,
    subscribe: vi.fn((listener: () => void) => {
      state.appSubscribers.add(listener)
      return () => state.appSubscribers.delete(listener)
    }),
  },
}))
vi.mock('../../stores/statusStore', () => ({
  useStatusStore: {
    getState: () => state.status,
    subscribe: vi.fn((listener: () => void) => {
      state.statusSubscribers.add(listener)
      return () => state.statusSubscribers.delete(listener)
    }),
  },
}))
vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: { getState: () => state.settings },
}))
vi.mock('../terminal/terminalRegistry', () => ({
  terminalRegistry: {
    getEntry: () => state.entry,
    getFailure: () => state.failure,
    getOrCreate,
    subscribeFailure: vi.fn((listener: () => void) => {
      state.failureSubscribers.add(listener)
      return () => state.failureSubscribers.delete(listener)
    }),
    terminate,
  },
}))
vi.mock('../terminal/terminalBuffer', () => ({
  terminalBufferTail: () => state.terminalOutput,
}))
vi.mock('../terminal/terminalDriver', () => ({ submitTerminalText }))
vi.mock('../workspace/canvasAccess', () => ({
  placementForBackgroundPanel: (_workspaceId: string, placementGroupId: string) => ({
    target: 'canvas',
    placementGroupId,
  }),
}))
vi.mock('../../stores/useWorktreeActions', () => ({
  createWorktreeForWorkspace,
}))
vi.mock('./agentCliHooks', () => ({ resolveDriverAgentCli }))

import { AGENTS } from '../../../shared/agents'
import { codingAgentSnapshot, handleCodingAgentMethod } from './codingAgentDriver'

describe('codingAgentDriver mission integration', () => {
  beforeEach(() => {
    state.failure = null
    state.terminalOutput = 'worker output'
    state.entry = { ptyId: 'pty-1', alive: true, terminal: {} }
    state.status = { workspaces: {} }
    state.appSubscribers.clear()
    state.statusSubscribers.clear()
    state.failureSubscribers.clear()
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
    terminate.mockClear()
    createWorktreeForWorkspace.mockReset()
  })

  it('automatically selects a hook-ready canonical agent and starts its PTY headlessly', async () => {
    const outcome = await handleCodingAgentMethod(
      'ws',
      'supervisor-1',
      'cate.codingAgent.create',
      { prompt: 'Implement it' },
    )

    expect(outcome.ok).toBe(true)
    expect(outcome).toMatchObject({
      result: {
        status: 'starting',
        alive: true,
      },
    })
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

  it('returns the useful CLI output when a worker exits unsuccessfully', async () => {
    await handleCodingAgentMethod(
      'ws',
      'supervisor-1',
      'cate.codingAgent.create',
      { agentId: 'codex', prompt: 'Implement it' },
    )
    const run = state.app.workspaces[0].panels.worker.codingAgentRun
    state.app.workspaces[0].panels.worker.codingAgentRun = {
      ...run,
      endedAt: 2,
      exitCode: 1,
    }
    state.terminalOutput = [
      'Error: You have no usage remaining for Codex.',
      '[Process exited with code 1]',
    ].join('\n')

    const outcome = await handleCodingAgentMethod(
      'ws',
      'supervisor-1',
      'cate.codingAgent.wait',
      { runIds: [run.id] },
    )

    expect(outcome).toMatchObject({
      ok: true,
      result: {
        timedOut: false,
        changedRunIds: [run.id],
        runs: [{
          id: run.id,
          status: 'failed',
          failureReason: 'Process exited with code 1: Error: You have no usage remaining for Codex.',
        }],
      },
    })
  })

  it('targets a registered remote-runtime worktree without losing its runtime', async () => {
    state.app.workspaces[0].rootPath = 'cate-runtime://remote-1/repo'
    state.app.workspaces[0].worktrees = [{ id: 'wt-1', path: '/repo-wt' }]

    const outcome = await handleCodingAgentMethod(
      'ws',
      'supervisor-1',
      'cate.codingAgent.create',
      { agentId: 'codex', prompt: 'Implement remotely', worktreeId: 'wt-1' },
    )

    expect(outcome.ok).toBe(true)
    expect(resolveDriverAgentCli).toHaveBeenCalledWith(
      'cate-runtime://remote-1/repo-wt',
      'codex',
      expect.any(Object),
    )
    expect(state.app.createTerminal).toHaveBeenCalledWith(
      'ws',
      undefined,
      undefined,
      expect.objectContaining({ placementGroupId: 'coding-agent:wt-1' }),
      'cate-runtime://remote-1/repo-wt',
      expect.any(Object),
    )
    expect(state.app.setPanelWorktreeId).toHaveBeenCalledWith('ws', 'worker', 'wt-1')
  })

  it('creates a requested worktree and launches the worker inside it', async () => {
    state.app.workspaces[0].worktrees = [{ id: 'wt-new', path: '/repo/.cate-wt/new' }]
    createWorktreeForWorkspace.mockResolvedValue({ id: 'wt-new' })

    const outcome = await handleCodingAgentMethod(
      'ws',
      'supervisor-1',
      'cate.codingAgent.create',
      { prompt: 'Implement in isolation', newWorktree: 'agent/test', baseRef: 'main' },
    )

    expect(outcome.ok).toBe(true)
    expect(createWorktreeForWorkspace).toHaveBeenCalledWith('/repo', 'ws', 'agent/test', 'main')
    expect(state.app.createTerminal).toHaveBeenCalledWith(
      'ws',
      undefined,
      undefined,
      expect.any(Object),
      '/repo/.cate-wt/new',
      expect.any(Object),
    )
  })

  it.each([
    [{}, 'prompt-required'],
    [{ prompt: '\0bad' }, 'invalid-prompt'],
    [{ prompt: 'x'.repeat(50_001) }, 'prompt-too-long'],
    [{ prompt: 'task', worktreeId: 'wt', newWorktree: 'new' }, 'choose-worktreeId-or-newWorktree'],
    [{ prompt: 'task', worktreeId: 'missing' }, 'worktree-not-registered'],
  ])('rejects invalid create arguments %# before creating a panel', async (args, error) => {
    await expect(handleCodingAgentMethod(
      'ws',
      'supervisor-1',
      'cate.codingAgent.create',
      args,
    )).resolves.toEqual({ ok: false, error })
    expect(state.app.createTerminal).not.toHaveBeenCalled()
  })

  it('inspects recent output and sends a durable follow-up to a supported worker', async () => {
    await handleCodingAgentMethod('ws', 'supervisor-1', 'cate.codingAgent.create', {
      agentId: 'codex', prompt: 'Implement it',
    })
    const run = state.app.workspaces[0].panels.worker.codingAgentRun

    await expect(handleCodingAgentMethod(
      'ws', 'supervisor-1', 'cate.codingAgent.inspect', { runId: run.id },
    )).resolves.toMatchObject({
      ok: true,
      result: { id: run.id, recentOutput: 'worker output' },
    })
    await expect(handleCodingAgentMethod(
      'ws', 'supervisor-1', 'cate.codingAgent.send', { runId: run.id, prompt: 'Now test it' },
    )).resolves.toMatchObject({ ok: true, result: { id: run.id } })

    expect(submitTerminalText).toHaveBeenCalledWith('worker', 'Now test it')
    expect(state.app.workspaces[0].panels.worker.codingAgentRun.followUps).toEqual([
      { prompt: 'Now test it', sentAt: expect.any(Number) },
    ])
  })

  it('enforces follow-up capability and terminal readiness', async () => {
    resolveDriverAgentCli.mockResolvedValue(AGENTS.find((agent) => agent.id === 'opencode'))
    await handleCodingAgentMethod('ws', 'supervisor-1', 'cate.codingAgent.create', {
      agentId: 'opencode', prompt: 'Implement it',
    })
    const run = state.app.workspaces[0].panels.worker.codingAgentRun
    await expect(handleCodingAgentMethod(
      'ws', 'supervisor-1', 'cate.codingAgent.send', { runId: run.id, prompt: 'Again' },
    )).resolves.toEqual({ ok: false, error: 'coding-agent-follow-up-unsupported' })

    run.agentId = 'codex'
    submitTerminalText.mockResolvedValueOnce(false)
    await expect(handleCodingAgentMethod(
      'ws', 'supervisor-1', 'cate.codingAgent.send', { runId: run.id, prompt: 'Again' },
    )).resolves.toEqual({ ok: false, error: 'coding-agent-not-ready' })
  })

  it('stops only the owned worker while retaining its terminal panel', async () => {
    await handleCodingAgentMethod('ws', 'supervisor-1', 'cate.codingAgent.create', {
      agentId: 'codex', prompt: 'Implement it',
    })
    const run = state.app.workspaces[0].panels.worker.codingAgentRun

    const outcome = await handleCodingAgentMethod(
      'ws', 'supervisor-1', 'cate.codingAgent.stop', { runId: run.id },
    )

    expect(outcome).toMatchObject({ ok: true, result: { status: 'stopped' } })
    expect(terminate).toHaveBeenCalledWith('worker')
    expect(state.app.workspaces[0].panels.worker.codingAgentRun.stoppedAt).toEqual(expect.any(Number))
  })

  it('waits for an actionable status transition and unsubscribes', async () => {
    state.status = {
      workspaces: { ws: { terminals: { 'pty-1': { agentState: 'running', agentPresent: true } } } },
    }
    await handleCodingAgentMethod('ws', 'supervisor-1', 'cate.codingAgent.create', {
      agentId: 'codex', prompt: 'Implement it',
    })
    const run = state.app.workspaces[0].panels.worker.codingAgentRun
    const waiting = handleCodingAgentMethod(
      'ws', 'supervisor-1', 'cate.codingAgent.wait', { runIds: [run.id], timeoutSeconds: 15 },
    )
    expect(state.appSubscribers.size).toBe(1)

    state.app.workspaces[0].panels.worker.codingAgentRun = {
      ...run, endedAt: Date.now(), exitCode: 0,
    }
    for (const listener of [...state.appSubscribers]) listener()

    await expect(waiting).resolves.toMatchObject({
      ok: true,
      result: { timedOut: false, changedRunIds: [run.id], runs: [{ status: 'ready' }] },
    })
    expect(state.appSubscribers.size).toBe(0)
    expect(state.statusSubscribers.size).toBe(0)
    expect(state.failureSubscribers.size).toBe(0)
  })

  it('returns the current compact snapshot when a wait times out', async () => {
    vi.useFakeTimers()
    try {
      state.status = {
        workspaces: { ws: { terminals: { 'pty-1': { agentState: 'running', agentPresent: true } } } },
      }
      await handleCodingAgentMethod('ws', 'supervisor-1', 'cate.codingAgent.create', {
        agentId: 'codex', prompt: 'Implement it',
      })
      const run = state.app.workspaces[0].panels.worker.codingAgentRun
      const waiting = handleCodingAgentMethod(
        'ws', 'supervisor-1', 'cate.codingAgent.wait', { runIds: [run.id], timeoutSeconds: 15 },
      )
      await vi.advanceTimersByTimeAsync(15_000)
      await expect(waiting).resolves.toMatchObject({
        ok: true,
        result: { timedOut: true, changedRunIds: [], runs: [{ id: run.id, status: 'working' }] },
      })
    } finally {
      vi.useRealTimers()
    }
  })
})
