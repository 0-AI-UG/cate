import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isRpcError } from '@kernel/rpc/contract'
import type { AgentId, CodingAgentRun, PanelAgentState } from '../../contract'
import { createMissions, type Missions, type MissionTerminals, type MissionWorktrees, type WorktreeReview } from './missions'

interface FakeTerminal {
  started: boolean
  alive: boolean
  failure: string | null
  busy: boolean
  cwd: string
  output: string
  agent: PanelAgentState | null
}

let terminals: Map<string, FakeTerminal>
let terminalListeners: Set<() => void>
let worktrees: Map<string, string>
let panelWorktrees: Map<string, string>
let created: Array<Parameters<MissionTerminals['create']>[0]>
let relaunched: Array<{ panelId: string; params: Parameters<MissionTerminals['relaunch']>[1] }>
let terminated: string[]
let submitted: Array<{ panelId: string; prompt: string }>
let submitOk: boolean
let resolveAgent: ReturnType<typeof vi.fn>
let repo: { [K in keyof MissionWorktrees]: ReturnType<typeof vi.fn> }
let saved: CodingAgentRun[]
let missions: Missions
let panelSeq: number

const agentState = (agentId: AgentId, status: PanelAgentState['status']): PanelAgentState => ({
  panelId: 'x', runner: 'terminal', agentId, agentName: null, status, present: true, canReceivePrompt: status === 'waitingForInput', session: null,
})

function changed(): void {
  for (const listener of terminalListeners) listener()
}

function build(store?: CodingAgentRun[]): Missions {
  return createMissions({
    root: '/repo',
    terminals: {
      async create(params) {
        created.push(params)
        const panelId = `worker-${++panelSeq}`
        terminals.set(panelId, { started: true, alive: true, failure: null, busy: false, cwd: params.cwd, output: 'worker output', agent: null })
        return panelId
      },
      async relaunch(panelId, params) {
        relaunched.push({ panelId, params })
      },
      isTerminal: (panelId) => terminals.has(panelId),
      state: (panelId) => {
        const t = terminals.get(panelId)
        return t
          ? { started: t.started, alive: t.alive, failure: t.failure, cwd: t.cwd, busy: t.busy }
          : { started: false, alive: false, failure: null, cwd: null, busy: false }
      },
      tail: async (panelId) => terminals.get(panelId)?.output ?? '',
      terminate: (panelId) => { terminated.push(panelId); const t = terminals.get(panelId); if (t) t.alive = false },
      onChange: (listener) => { terminalListeners.add(listener); return () => { terminalListeners.delete(listener) } },
    },
    worktrees: repo as unknown as MissionWorktrees,
    worktreePath: (id) => worktrees.get(id),
    panelWorktree: (panelId) => panelWorktrees.get(panelId),
    agentState: (panelId) => terminals.get(panelId)?.agent ?? null,
    submit: async (panelId, prompt) => { submitted.push({ panelId, prompt }); return submitOk },
    resolveAgent: resolveAgent as never,
    store: { load: () => store ?? [], save: (runs) => { saved = runs } },
    now: () => 1_000,
  })
}

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    expect(isRpcError(error)).toBe(true)
    return (error as Error).message
  }
  throw new Error('expected a rejection')
}

const isolatedRun = (overrides: Partial<CodingAgentRun> = {}): CodingAgentRun => ({
  id: 'run-1', agentId: 'codex', panelId: 'worker', ownerPanelId: 'supervisor-1', prompt: 'Implement it',
  worktreeId: 'wt-1', ownsWorktree: true, createdAt: 1, endedAt: 2, exitCode: 0, ...overrides,
})

beforeEach(() => {
  terminals = new Map()
  terminalListeners = new Set()
  worktrees = new Map([['wt-1', '/repo/.cate/worktrees/wt-1']])
  panelWorktrees = new Map()
  created = []
  relaunched = []
  terminated = []
  submitted = []
  submitOk = true
  panelSeq = 0
  saved = []
  resolveAgent = vi.fn(async () => 'codex')
  const review: WorktreeReview = { branch: 'agent/api', baseBranch: 'main', canApply: true, dirty: false }
  repo = {
    create: vi.fn(async (name: string) => { worktrees.set('wt-new', `/repo/.cate/worktrees/${name}`); return { id: 'wt-new', path: `/repo/.cate/worktrees/${name}` } }),
    remove: vi.fn(async () => {}),
    status: vi.fn(async () => ({ dirty: true, branch: 'agent/api' })),
    primaryBranch: vi.fn(async () => 'main'),
    review: vi.fn(async () => review),
    merge: vi.fn(async () => ({ ok: true as const })),
  }
  missions = build()
})

describe('missions', () => {
  it('selects a hook-ready agent and starts its worker in a new terminal panel', async () => {
    const result = await missions.create('supervisor-1', { prompt: 'Implement it' })
    expect(resolveAgent).toHaveBeenCalledWith('/repo', '')
    expect(created).toEqual([{
      cwd: '/repo',
      worktreeId: undefined,
      title: 'Implement it',
      placementGroupId: 'coding-agent:primary',
      launch: { kind: 'agents.mission', params: { agentId: 'codex', prompt: 'Implement it' } },
    }])
    expect(result).toMatchObject({ agentId: 'codex', agentName: 'Codex', panelId: 'worker-1', status: 'starting', alive: true, background: true })
    expect(saved).toHaveLength(1)
  })

  it('keeps a short title and whether the supervisor must wait explicitly', async () => {
    const result = await missions.create('supervisor-1', { prompt: 'Implement it', title: 'API tests', background: false })
    expect(result).toMatchObject({ title: 'API tests', background: false })
    expect(created[0].title).toBe('API tests')
    await expect(rejection(missions.create('supervisor-1', { prompt: 'x', title: 'y'.repeat(81) }))).resolves.toBe('title-too-long')
  })

  it('reuses an idle terminal panel and rejects busy, owned and caller terminals', async () => {
    terminals.set('idle', { started: true, alive: true, failure: null, busy: false, cwd: '/repo', output: '', agent: null })
    terminals.set('busy', { started: true, alive: true, failure: null, busy: true, cwd: '/repo', output: '', agent: null })
    const result = await missions.create('supervisor-1', { prompt: 'Implement it', terminalPanelId: 'idle' })
    expect(result.panelId).toBe('idle')
    expect(relaunched).toEqual([{ panelId: 'idle', params: { cwd: '/repo', worktreeId: undefined, launch: expect.objectContaining({ kind: 'agents.mission' }) } }])
    expect(created).toEqual([])

    await expect(rejection(missions.create('supervisor-1', { prompt: 'x', terminalPanelId: 'idle' }))).resolves.toBe('terminal-already-has-agent')
    await expect(rejection(missions.create('supervisor-1', { prompt: 'x', terminalPanelId: 'busy' }))).resolves.toBe('terminal-busy')
    await expect(rejection(missions.create('supervisor-1', { prompt: 'x', terminalPanelId: 'supervisor-1' }))).resolves.toBe('agent-cannot-replace-caller-terminal')
    await expect(rejection(missions.create('supervisor-1', { prompt: 'x', terminalPanelId: 'nope' }))).resolves.toBe('terminal-not-found')
  })

  it('lists runs per supervisor and isolates run lookup to the supervisor that created it', async () => {
    const first = await missions.create('supervisor-1', { prompt: 'One' })
    await missions.create('supervisor-2', { prompt: 'Two' })
    expect((await missions.list('supervisor-1')).map((run) => run.id)).toEqual([first.id])
    await expect(rejection(missions.inspect('supervisor-2', first.id))).resolves.toBe('coding-agent-not-found')
    expect(missions.interactionTargets('supervisor-1', 'cate.codingAgent.send', { runId: first.id })).toEqual([first.panelId])
    expect(missions.interactionTargets('supervisor-2', 'cate.codingAgent.send', { runId: first.id })).toEqual([])
  })

  it('rejects a non-ready agent before creating a terminal and removes a worktree it created', async () => {
    resolveAgent.mockRejectedValue(new Error('Codex is selected as the engineering agent, but its Cate hooks are not enabled'))
    const message = await rejection(missions.create('supervisor-1', { prompt: 'x', agentId: 'codex', newWorktree: 'api' }))
    expect(message).toMatch(/^agent-hooks-not-ready: Codex is selected/)
    expect(created).toEqual([])
    expect(repo.remove).toHaveBeenCalledWith('wt-new', { force: true, deleteBranch: true })
    await expect(rejection(missions.create('supervisor-1', { prompt: 'x', agentId: '/bin/sh' }))).resolves.toBe('unsupported-agent')
  })

  it('admits at most five active workers per mission', async () => {
    for (let i = 0; i < 5; i++) await missions.create('supervisor-1', { prompt: `Task ${i}` })
    await expect(rejection(missions.create('supervisor-1', { prompt: 'Sixth' }))).resolves.toBe('coding-agent-limit')
    await expect(missions.create('supervisor-2', { prompt: 'Other mission' })).resolves.toMatchObject({ status: 'starting' })
    // A finished worker frees its slot.
    missions.noteExit('worker-1', 0)
    await expect(missions.create('supervisor-1', { prompt: 'Sixth' })).resolves.toMatchObject({ status: 'starting' })
  })

  it('stops every live worker of a deleted mission and refuses new ones', async () => {
    const run = await missions.create('supervisor-1', { prompt: 'x' })
    expect(missions.stopAll('supervisor-1')).toEqual({ stopped: 1 })
    expect(terminated).toEqual([run.panelId])
    await expect(rejection(missions.create('supervisor-1', { prompt: 'y' }))).resolves.toBe('mission-deleted')
  })

  it('cancels an in-flight create when its mission is deleted during hook preflight', async () => {
    let release!: () => void
    resolveAgent.mockImplementation(() => new Promise((resolve) => { release = () => resolve('codex') }))
    const pending = missions.create('supervisor-1', { prompt: 'x', newWorktree: 'api' })
    await vi.waitFor(() => expect(resolveAgent).toHaveBeenCalled())
    missions.stopAll('supervisor-1')
    release()
    await expect(rejection(pending)).resolves.toBe('mission-deleted')
    expect(created).toEqual([])
    expect(repo.remove).toHaveBeenCalledWith('wt-new', { force: true, deleteBranch: true })
  })

  it('reports terminal startup failures and the useful output of an unsuccessful exit', async () => {
    const run = await missions.create('supervisor-1', { prompt: 'x' })
    terminals.get(run.panelId)!.failure = 'spawn codex ENOENT'
    await expect(missions.inspect('supervisor-1', run.id)).resolves.toMatchObject({ status: 'failed', failureReason: 'spawn codex ENOENT' })

    terminals.get(run.panelId)!.failure = null
    terminals.get(run.panelId)!.output = 'Error: You have no usage remaining for Codex.\n[Process exited with code 1]'
    missions.noteExit(run.panelId, 1)
    await expect(missions.wait('supervisor-1', { runIds: [run.id], timeoutSeconds: 5 })).resolves.toMatchObject({
      timedOut: false,
      changedRunIds: [run.id],
      runs: [{ id: run.id, status: 'failed', failureReason: 'Process exited with code 1: Error: You have no usage remaining for Codex.' }],
    })
  })

  it('inherits the caller\'s worktree, or runs in a requested or new one', async () => {
    panelWorktrees.set('supervisor-1', 'wt-1')
    await missions.create('supervisor-1', { prompt: 'x' })
    expect(created[0]).toMatchObject({ cwd: '/repo/.cate/worktrees/wt-1', worktreeId: 'wt-1', placementGroupId: 'coding-agent:wt-1' })

    await missions.create('supervisor-2', { prompt: 'x', worktreeId: 'wt-1' })
    expect(created[1]).toMatchObject({ worktreeId: 'wt-1' })
    await expect(rejection(missions.create('supervisor-2', { prompt: 'x', worktreeId: 'missing' }))).resolves.toBe('worktree-not-registered')

    const fresh = await missions.create('supervisor-3', { prompt: 'x', newWorktree: 'api', baseRef: 'main' })
    expect(repo.create).toHaveBeenCalledWith('api', 'main')
    expect(created.at(-1)).toMatchObject({ cwd: '/repo/.cate/worktrees/api', worktreeId: 'wt-new' })
    expect(fresh).toMatchObject({ worktreeId: 'wt-new', ownsWorktree: true })
    await expect(rejection(missions.create('supervisor-3', { prompt: 'x', worktreeId: 'wt-1', newWorktree: 'b' }))).resolves.toBe('choose-worktreeId-or-newWorktree')
  })

  it('inspects recent output and sends a durable follow-up', async () => {
    const run = await missions.create('supervisor-1', { prompt: 'x', agentId: 'opencode' })
    await expect(missions.inspect('supervisor-1', run.id)).resolves.toMatchObject({ recentOutput: 'worker output', statusLine: 'worker output' })
    await expect(missions.send('supervisor-1', run.id, 'Again')).resolves.toMatchObject({ id: run.id, followUpSupported: true })
    expect(submitted).toEqual([{ panelId: run.panelId, prompt: 'Again' }])
    expect(saved[0].followUps).toEqual([{ prompt: 'Again', sentAt: 1_000 }])
    submitOk = false
    await expect(rejection(missions.send('supervisor-1', run.id, 'More'))).resolves.toBe('coding-agent-not-ready')
  })

  it('reviews, applies, keeps and discards an owned isolated worker', async () => {
    terminals.set('worker', { started: true, alive: false, failure: null, busy: false, cwd: '/repo/.cate/worktrees/wt-1', output: '', agent: null })
    missions = build([isolatedRun()])
    await expect(missions.review('supervisor-1', 'run-1')).resolves.toMatchObject({ id: 'run-1', review: { canApply: true } })
    await expect(missions.apply('supervisor-1', 'run-1')).resolves.toMatchObject({ id: 'run-1', appliedToBranch: 'main' })
    expect(repo.merge).toHaveBeenCalledWith('agent/api', 'main')
    await expect(rejection(missions.apply('supervisor-1', 'run-1'))).resolves.toBe('coding-agent-already-applied')
    await expect(missions.keep('supervisor-1', 'run-1')).resolves.toMatchObject({ keptAt: 1_000 })
    await expect(missions.discard('supervisor-1', 'run-1')).resolves.toMatchObject({ id: 'run-1' })
    expect(repo.remove).toHaveBeenCalledWith('wt-1', { force: true, deleteBranch: true })
    expect(saved[0]).toMatchObject({ ownsWorktree: false })
    expect(saved[0].worktreeId).toBeUndefined()
  })

  it('requires another review when the target branch changes before applying', async () => {
    terminals.set('worker', { started: true, alive: false, failure: null, busy: false, cwd: '/w', output: '', agent: null })
    missions = build([isolatedRun()])
    repo.review
      .mockResolvedValueOnce({ branch: 'agent/api', baseBranch: 'main', canApply: true, dirty: false })
      .mockResolvedValueOnce({ branch: 'agent/api', baseBranch: 'develop', canApply: true, dirty: false })
    await expect(rejection(missions.apply('supervisor-1', 'run-1'))).resolves.toBe(
      'The current branch changed from main to develop. Review again before applying.',
    )
    expect(repo.merge).not.toHaveBeenCalled()
  })

  it('does not integrate active workers or discard worktrees the worker does not own', async () => {
    terminals.set('worker', { started: true, alive: true, failure: null, busy: false, cwd: '/w', output: '', agent: agentState('codex', 'running') })
    missions = build([isolatedRun({ ownsWorktree: false, endedAt: undefined, exitCode: undefined })])
    await expect(rejection(missions.apply('supervisor-1', 'run-1'))).resolves.toBe('coding-agent-not-ready')
    await expect(rejection(missions.keep('supervisor-1', 'run-1'))).resolves.toBe('coding-agent-not-ready')
    await expect(rejection(missions.discard('supervisor-1', 'run-1'))).resolves.toBe('worker-does-not-own-worktree')
    await expect(rejection(missions.review('supervisor-2', 'run-1'))).resolves.toBe('coding-agent-not-found')
    expect(repo.merge).not.toHaveBeenCalled()
    expect(repo.remove).not.toHaveBeenCalled()
  })

  it('stops only the owned worker while keeping its panel', async () => {
    const run = await missions.create('supervisor-1', { prompt: 'x' })
    await expect(rejection(missions.stop('supervisor-2', run.id))).resolves.toBe('coding-agent-not-found')
    await expect(missions.stop('supervisor-1', run.id)).resolves.toMatchObject({ status: 'stopped' })
    expect(terminated).toEqual([run.panelId])
  })

  it('waits for an actionable status transition and stops listening', async () => {
    const run = await missions.create('supervisor-1', { prompt: 'x' })
    terminals.get(run.panelId)!.agent = agentState('codex', 'running')
    const before = terminalListeners.size
    const waiting = missions.wait('supervisor-1', { runIds: [run.id], timeoutSeconds: 15 })
    await Promise.resolve()
    terminals.get(run.panelId)!.agent = agentState('codex', 'waitingForInput')
    changed()
    await expect(waiting).resolves.toMatchObject({ timedOut: false, changedRunIds: [run.id], runs: [{ status: 'waiting' }] })
    expect(terminalListeners.size).toBe(before)
  })

  it('uses a rolling supplied baseline for background re-arming', async () => {
    const run = await missions.create('supervisor-1', { prompt: 'x' })
    terminals.get(run.panelId)!.agent = agentState('codex', 'running')
    const waiting = missions.wait('supervisor-1', { runIds: [run.id], baselineStatuses: { [run.id]: 'waiting' }, timeoutSeconds: 5 })
    // waiting -> working moves the baseline but must not wake the supervisor.
    changed()
    await new Promise((resolve) => setTimeout(resolve, 10))
    terminals.get(run.panelId)!.agent = agentState('codex', 'waitingForInput')
    changed()
    await expect(waiting).resolves.toMatchObject({ changedRunIds: [run.id], runs: [{ status: 'waiting' }] })
  })

  it('returns the current compact snapshot when a wait times out', async () => {
    vi.useFakeTimers()
    try {
      const run = await missions.create('supervisor-1', { prompt: 'x' })
      terminals.get(run.panelId)!.agent = agentState('codex', 'running')
      const waiting = missions.wait('supervisor-1', { runIds: [run.id], timeoutSeconds: 15 })
      await vi.advanceTimersByTimeAsync(15_000)
      await expect(waiting).resolves.toMatchObject({ timedOut: true, changedRunIds: [], runs: [{ id: run.id, status: 'working' }] })
    } finally {
      vi.useRealTimers()
    }
  })

  it('without run ids, waits only for live work', async () => {
    const run = await missions.create('supervisor-1', { prompt: 'x' })
    missions.noteExit(run.panelId, 0)
    await expect(missions.wait('supervisor-1', { timeoutSeconds: 5 })).resolves.toEqual({ timedOut: false, changedRunIds: [], runs: [] })
  })
})
