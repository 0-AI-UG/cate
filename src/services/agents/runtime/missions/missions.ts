// Missions (`cate.codingAgent.*`): a supervisor panel starts worker agents in
// terminals, admission limits them, and each worker's isolated worktree is
// reviewed, then applied, kept or discarded. Workers use the terminal runner.
// Panels and worktrees are created through injected ports, since panel
// sessions and the repository lifecycle live in other modules.

import { randomUUID } from 'node:crypto'
import { RpcError } from '@kernel/rpc/contract'
import {
  ACTIVE_CODING_AGENT_STATUSES,
  AGENT_DEFS,
  AGENT_LAUNCH,
  actionableCodingAgentRunIds,
  changedCodingAgentRunIds,
  codingAgentSupportsFollowUp,
  compactCodingAgentSnapshot,
  deriveCodingAgentRunStatus,
  parseCodingAgentId,
  type AgentId,
  type CodingAgentRun,
  type CodingAgentRunSnapshot,
  type CodingAgentRunStatus,
  type CompactCodingAgentSnapshot,
  type PanelAgentState,
} from '../../contract'
import type { PlaceTarget } from '@workspace/document/contract'
import { CodingAgentAdmission } from './admission'

/** A launch the terminal service resolves (a registered launch intent). */
export interface WorkerLaunch {
  kind: string
  params: unknown
}

/** Terminal panels as missions drive them (terminal panel sessions). */
export interface MissionTerminals {
  /** A new terminal panel running `launch` in `cwd`, placed with its group.
   *  Resolves with the panel id once its PTY started. */
  create(params: { cwd: string; worktreeId?: string; title: string; placementGroupId: string; launch: WorkerLaunch; at?: PlaceTarget }): Promise<string>
  /** Restarts an existing terminal panel's PTY with `launch`: whatever ran in
   *  it dies, and no shell quoting is involved. */
  relaunch(panelId: string, params: { cwd: string; worktreeId?: string; launch: WorkerLaunch }): Promise<void>
  isTerminal(panelId: string): boolean
  state(panelId: string): { started: boolean; alive: boolean; failure: string | null; cwd: string | null; busy: boolean }
  /** Recent screen text. */
  tail(panelId: string): Promise<string>
  /** Kills the PTY; the panel and its screen stay. */
  terminate(panelId: string): void
  onChange(listener: () => void): () => void
}

export interface WorktreeReview {
  canApply: boolean
  message?: string
  baseBranch: string
  branch: string
  dirty: boolean
  [key: string]: unknown
}

/** Worktrees as missions use them (repository worktree lifecycle). */
export interface MissionWorktrees {
  create(name: string, baseRef?: string): Promise<{ id: string; path: string }>
  /** Removes a worktree with its panels, checkout and metadata; `deleteBranch`
   *  also deletes its branch. `force` discards uncommitted work. */
  remove(worktreeId: string, options: { force: boolean; deleteBranch: boolean }): Promise<void>
  status(worktreeId: string): Promise<{ dirty: boolean; branch: string } | null>
  /** The primary checkout's current branch. */
  primaryBranch(): Promise<string | null>
  review(worktreeId: string, baseBranch: string): Promise<WorktreeReview>
  merge(branch: string, into: string): Promise<{ ok: true } | { ok: false; message: string }>
}

/** Where runs are kept (`<data>/agents/missions.json`). */
export interface MissionStore {
  load(): CodingAgentRun[]
  save(runs: CodingAgentRun[]): void
}

export interface MissionsDeps {
  root: string
  terminals: MissionTerminals
  worktrees: MissionWorktrees
  /** Absolute path of a registered worktree. */
  worktreePath(worktreeId: string): string | undefined
  /** The worktree a panel is bound to. */
  panelWorktree(panelId: string): string | undefined
  /** The agent the worker's terminal hosts (terminal runner). */
  agentState(panelId: string): PanelAgentState | null
  /** Pastes a follow-up into the worker's PTY (terminal runner). */
  submit(panelId: string, prompt: string): Promise<boolean>
  /** The hook-ready agent a worker in `cwd` uses (strict for a preference). */
  resolveAgent(cwd: string, preferred: string): Promise<AgentId>
  store?: MissionStore
  now?: () => number
}

interface CreateWorkerArgs {
  prompt: string
  agentId?: string
  title?: string
  background?: boolean
  terminalPanelId?: string
  /** Where a new terminal goes; default: with the owner's other workers. */
  at?: PlaceTarget
  worktreeId?: string
  newWorktree?: string
  baseRef?: string
}

interface WaitResult {
  timedOut: boolean
  changedRunIds: string[]
  runs: CompactCodingAgentSnapshot[]
}

export interface Missions {
  create(ownerPanelId: string, args: CreateWorkerArgs): Promise<CompactCodingAgentSnapshot>
  send(ownerPanelId: string, runId: string, prompt: string): Promise<CompactCodingAgentSnapshot>
  list(ownerPanelId: string): Promise<CompactCodingAgentSnapshot[]>
  wait(ownerPanelId: string, options: { runIds?: string[]; timeoutSeconds: number; baselineStatuses?: Record<string, string>; signal?: AbortSignal }): Promise<WaitResult>
  inspect(ownerPanelId: string, runId: string): Promise<CompactCodingAgentSnapshot & { recentOutput: string }>
  review(ownerPanelId: string, runId: string): Promise<CompactCodingAgentSnapshot & { review: WorktreeReview }>
  apply(ownerPanelId: string, runId: string): Promise<CompactCodingAgentSnapshot>
  keep(ownerPanelId: string, runId: string): Promise<CompactCodingAgentSnapshot>
  discard(ownerPanelId: string, runId: string): Promise<CompactCodingAgentSnapshot>
  stop(ownerPanelId: string, runId: string): Promise<CompactCodingAgentSnapshot>
  /** Stops every worker of the mission and refuses new ones. */
  stopAll(ownerPanelId: string): { stopped: number }
  snapshot(ownerPanelId: string, runId: string): Promise<CodingAgentRunSnapshot | null>
  /** Panels of the workers a mission command addresses. */
  interactionTargets(ownerPanelId: string, method: string, args: Record<string, unknown>): string[]
  /** A worker's PTY exited. */
  noteExit(panelId: string, exitCode: number): void
  /** Runs changed (status inputs or run records). */
  onChange(listener: () => void): () => void
  /** Any run or agent state changed: re-evaluate waits. */
  notifyChanged(): void
}

function fail(code: string): never {
  throw new RpcError('rejected', code)
}

export function createMissions(deps: MissionsDeps): Missions {
  const now = deps.now ?? Date.now
  const runs = new Map<string, CodingAgentRun>((deps.store?.load() ?? []).map((run) => [run.id, run]))
  const stoppedOwners = new Set<string>()
  const admission = new CodingAgentAdmission()
  const listeners = new Set<() => void>()

  const changed = (): void => {
    for (const listener of listeners) {
      try { listener() } catch { /* a waiter must not break the others */ }
    }
  }
  const put = (run: CodingAgentRun): void => {
    runs.set(run.id, run)
    deps.store?.save([...runs.values()])
    changed()
  }
  deps.terminals.onChange(changed)

  const ownedRun = (ownerPanelId: string, runId: string): CodingAgentRun | undefined => {
    const run = runs.get(runId)
    return run && run.ownerPanelId === ownerPanelId ? run : undefined
  }
  const runOfPanel = (panelId: string): CodingAgentRun | undefined =>
    [...runs.values()].find((run) => run.panelId === panelId && !run.stoppedAt && !run.endedAt)
    ?? [...runs.values()].reverse().find((run) => run.panelId === panelId)

  const statusOf = (run: CodingAgentRun): CodingAgentRunStatus => {
    const terminal = deps.terminals.state(run.panelId)
    const agent = deps.agentState(run.panelId)
    return deriveCodingAgentRunStatus(run, {
      terminalStarted: terminal.started,
      terminalAlive: terminal.alive,
      terminalFailed: terminal.failure !== null,
      agentState: agent?.status,
      agentPresent: agent?.present === true || Boolean(agent?.agentId),
    })
  }

  const snapshotOf = async (run: CodingAgentRun): Promise<CodingAgentRunSnapshot> => {
    const terminal = deps.terminals.state(run.panelId)
    const status = statusOf(run)
    const output = await deps.terminals.tail(run.panelId).catch(() => '')
    const lastLine = output.split('\n').reverse().find((line) => line.trim())?.trim()
    const failureDiagnostic = status === 'failed'
      ? output.split('\n').reverse().map((line) => line.trim())
          .find((line) => line && !/^\[Process exited with code \d+\]$/.test(line))
      : undefined
    const failureReason = terminal.failure
      ? terminal.failure.slice(0, 500)
      : status === 'failed'
        ? `Process exited with code ${run.exitCode ?? 'unknown'}${failureDiagnostic ? `: ${failureDiagnostic}` : ''}`.slice(0, 500)
        : undefined
    return {
      ...run,
      status,
      agentName: AGENT_DEFS[run.agentId].displayName,
      cwd: terminal.cwd ?? (run.worktreeId ? deps.worktreePath(run.worktreeId) : undefined) ?? deps.root,
      alive: terminal.alive,
      followUpSupported: codingAgentSupportsFollowUp(run.agentId),
      ...(lastLine ? { statusLine: lastLine.slice(0, 200) } : {}),
      ...(failureReason ? { failureReason } : {}),
    }
  }

  const ownedSnapshot = async (ownerPanelId: string, runId: string): Promise<CodingAgentRunSnapshot> => {
    const run = ownedRun(ownerPanelId, runId)
    if (!run) fail('coding-agent-not-found')
    return snapshotOf(run!)
  }

  const allOwned = (ownerPanelId: string): CodingAgentRun[] =>
    [...runs.values()].filter((run) => run.ownerPanelId === ownerPanelId).sort((a, b) => a.createdAt - b.createdAt)

  const activeCount = (ownerPanelId: string): number =>
    allOwned(ownerPanelId).filter((run) => ACTIVE_CODING_AGENT_STATUSES.includes(statusOf(run))).length

  const terminalError = (panelId: string, ownerPanelId: string): string | null => {
    if (panelId === ownerPanelId) return 'agent-cannot-replace-caller-terminal'
    if (!deps.terminals.isTerminal(panelId)) return 'terminal-not-found'
    if ([...runs.values()].some((run) => run.panelId === panelId && !run.stoppedAt && !run.endedAt)) return 'terminal-already-has-agent'
    const terminal = deps.terminals.state(panelId)
    if (!terminal.alive) return null
    if (deps.agentState(panelId)?.present || terminal.busy) return 'terminal-busy'
    return null
  }

  /** The worktree to run in: the requested one, else the caller's own. */
  const resolveTarget = (ownerPanelId: string, worktreeId: string | undefined): { cwd: string; worktreeId?: string } => {
    if (worktreeId) {
      const path = deps.worktreePath(worktreeId)
      if (!path) fail('worktree-not-registered')
      return { cwd: path!, worktreeId }
    }
    const inherited = deps.panelWorktree(ownerPanelId)
    const inheritedPath = inherited ? deps.worktreePath(inherited) : undefined
    return inherited && inheritedPath && inheritedPath !== deps.root
      ? { cwd: inheritedPath, worktreeId: inherited }
      : { cwd: deps.root }
  }

  const createWorker = async (ownerPanelId: string, args: CreateWorkerArgs): Promise<CompactCodingAgentSnapshot> => {
    const requestedAgentId = args.agentId === undefined ? '' : parseCodingAgentId(args.agentId)
    if (args.agentId !== undefined && !requestedAgentId) fail('unsupported-agent')
    const prompt = args.prompt.trim()
    const requestedTitle = args.title?.trim() ?? ''
    const background = args.background !== false
    if (!prompt) fail('prompt-required')
    if (requestedTitle.length > 80) fail('title-too-long')
    if (prompt.includes('\0')) fail('invalid-prompt')
    if (prompt.length > 50_000) fail('prompt-too-long')
    if (args.terminalPanelId) {
      const error = terminalError(args.terminalPanelId, ownerPanelId)
      if (error) fail(error)
    }
    if (args.worktreeId && args.newWorktree) fail('choose-worktreeId-or-newWorktree')

    let created: { id: string; path: string } | undefined
    const rollback = async (reason: string): Promise<never> => {
      if (created) {
        try {
          await deps.worktrees.remove(created.id, { force: true, deleteBranch: true })
        } catch (error) {
          fail(`${reason}; worktree-cleanup-failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      return fail(reason)
    }
    let worktreeId = args.worktreeId
    if (args.newWorktree?.trim()) {
      try {
        created = await deps.worktrees.create(args.newWorktree, args.baseRef)
        worktreeId = created.id
      } catch (error) {
        fail(error instanceof Error ? `worktree-create-failed: ${error.message}` : 'worktree-create-failed')
      }
    }
    if (stoppedOwners.has(ownerPanelId)) await rollback('mission-deleted')
    let target: { cwd: string; worktreeId?: string }
    try {
      target = created ? { cwd: created.path, worktreeId: created.id } : resolveTarget(ownerPanelId, worktreeId)
    } catch (error) {
      return rollback(error instanceof RpcError ? error.message : 'worktree-not-registered')
    }
    let agentId: AgentId
    try {
      agentId = await deps.resolveAgent(target.cwd, requestedAgentId || '')
    } catch (error) {
      return rollback(error instanceof Error ? `agent-hooks-not-ready: ${error.message}` : 'agent-hooks-not-ready')
    }
    if (stoppedOwners.has(ownerPanelId)) await rollback('mission-deleted')

    const runId = randomUUID()
    const title = requestedTitle || prompt.replace(/\s+/g, ' ').slice(0, 54)
    const launch: WorkerLaunch = { kind: AGENT_LAUNCH.mission, params: { agentId, prompt } }
    let panelId: string
    if (args.terminalPanelId) {
      // Reuse the panel, not its shell process: restarting the PTY launches
      // the canonical executable and argv directly.
      panelId = args.terminalPanelId
      put(runRecord())
      void deps.terminals.relaunch(panelId, { cwd: target.cwd, worktreeId: target.worktreeId, launch }).catch(() => {})
    } else {
      const placementGroupId = target.worktreeId ? `coding-agent:${target.worktreeId}` : 'coding-agent:primary'
      try {
        panelId = await deps.terminals.create({ cwd: target.cwd, worktreeId: target.worktreeId, title, placementGroupId, launch, ...(args.at ? { at: args.at } : {}) })
      } catch {
        return rollback('panel-creation-failed')
      }
      put(runRecord())
    }
    function runRecord(): CodingAgentRun {
      return {
        id: runId,
        agentId,
        panelId,
        ...(requestedTitle ? { title: requestedTitle } : {}),
        ownerPanelId,
        prompt,
        ownsWorktree: Boolean(created),
        background,
        createdAt: now(),
        ...(target.worktreeId ? { worktreeId: target.worktreeId } : {}),
      }
    }
    return compactCodingAgentSnapshot(await snapshotOf(runs.get(runId)!))
  }

  const readyIsolated = async (ownerPanelId: string, runId: string) => {
    const snapshot = await ownedSnapshot(ownerPanelId, runId)
    if (!snapshot.worktreeId) fail('coding-agent-not-isolated')
    return snapshot as CodingAgentRunSnapshot & { worktreeId: string }
  }

  const review = async (worktreeId: string): Promise<WorktreeReview> => {
    const base = await deps.worktrees.primaryBranch()
    if (!base) throw new Error('target-branch-not-found')
    return deps.worktrees.review(worktreeId, base)
  }

  const current = async (runId: string): Promise<CompactCodingAgentSnapshot> =>
    compactCodingAgentSnapshot(await snapshotOf(runs.get(runId)!))

  const requested = async (ownerPanelId: string, runIds: string[] | undefined): Promise<CodingAgentRunSnapshot[]> => {
    if (!runIds) return Promise.all(allOwned(ownerPanelId).map(snapshotOf))
    return Promise.all(runIds.map((runId) => ownedSnapshot(ownerPanelId, runId)))
  }

  return {
    async create(ownerPanelId, args) {
      if (!ownerPanelId) fail('mission-owner-required')
      if (stoppedOwners.has(ownerPanelId)) fail('mission-deleted')
      const admitted = await admission.admit({
        ownerPanelId,
        active: () => activeCount(ownerPanelId),
        create: () => createWorker(ownerPanelId, args),
      })
      if (!admitted.admitted) fail('coding-agent-limit')
      return (admitted as { result: CompactCodingAgentSnapshot }).result
    },

    async send(ownerPanelId, runId, prompt) {
      const run = ownedRun(ownerPanelId, runId)
      const text = prompt.trim()
      if (!run) fail('coding-agent-not-found')
      if (!text) fail('prompt-required')
      if (run!.stoppedAt) fail('coding-agent-stopped')
      if (!codingAgentSupportsFollowUp(run!.agentId)) fail('coding-agent-follow-up-unsupported')
      if (!(await deps.submit(run!.panelId, text))) fail('coding-agent-not-ready')
      const latest = runs.get(runId)!
      put({ ...latest, followUps: [...(latest.followUps ?? []), { prompt: text, sentAt: now() }] })
      return current(runId)
    },

    async list(ownerPanelId) {
      return (await requested(ownerPanelId, undefined)).map(compactCodingAgentSnapshot)
    },

    async wait(ownerPanelId, options) {
      const initial = await requested(ownerPanelId, options.runIds)
      // With no explicit target, watch only live work: historical ready runs
      // must not make every later wait return at once.
      const watched = options.runIds === undefined
        ? initial.filter((run) => ACTIVE_CODING_AGENT_STATUSES.includes(run.status))
        : initial
      if (watched.length === 0) return { timedOut: false, changedRunIds: [], runs: [] }
      const supplied = options.baselineStatuses
      const actionable = supplied ? [] : actionableCodingAgentRunIds(watched)
      if (actionable.length > 0) {
        return { timedOut: false, changedRunIds: actionable, runs: watched.map(compactCodingAgentSnapshot) }
      }
      const ids = watched.map((run) => run.id)
      const baseline = new Map<string, CodingAgentRunStatus>(watched.map((run) => [
        run.id,
        typeof supplied?.[run.id] === 'string' ? supplied[run.id] as CodingAgentRunStatus : run.status,
      ]))
      return new Promise<WaitResult>((resolve, reject) => {
        let settled = false
        let checking = false
        let again = false
        const finish = (outcome: WaitResult | Error): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          off()
          options.signal?.removeEventListener('abort', onAbort)
          if (outcome instanceof Error) reject(outcome)
          else resolve(outcome)
        }
        const check = async (): Promise<void> => {
          if (settled) return
          if (checking) { again = true; return }
          checking = true
          try {
            const snapshots = await requested(ownerPanelId, ids)
            const changedRunIds = changedCodingAgentRunIds(baseline, snapshots)
            for (const snapshot of snapshots) baseline.set(snapshot.id, snapshot.status)
            if (changedRunIds.length > 0) finish({ timedOut: false, changedRunIds, runs: snapshots.map(compactCodingAgentSnapshot) })
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)))
          } finally {
            checking = false
            if (again && !settled) { again = false; void check() }
          }
        }
        const onAbort = (): void => finish(new RpcError('timeout', 'wait cancelled'))
        const off = (() => {
          const listener = () => { void check() }
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        })()
        const timer = setTimeout(() => {
          void requested(ownerPanelId, ids)
            .then((snapshots) => finish({ timedOut: true, changedRunIds: [], runs: snapshots.map(compactCodingAgentSnapshot) }))
            .catch((error) => finish(error instanceof Error ? error : new Error(String(error))))
        }, options.timeoutSeconds * 1_000)
        options.signal?.addEventListener('abort', onAbort)
        // Close the gap between the initial snapshot and the listener.
        void check()
      })
    },

    async inspect(ownerPanelId, runId) {
      const snapshot = await ownedSnapshot(ownerPanelId, runId)
      return { ...compactCodingAgentSnapshot(snapshot), recentOutput: await deps.terminals.tail(snapshot.panelId).catch(() => '') }
    },

    async review(ownerPanelId, runId) {
      const snapshot = await readyIsolated(ownerPanelId, runId)
      try {
        return { ...compactCodingAgentSnapshot(snapshot), review: await review(snapshot.worktreeId) }
      } catch (error) {
        return fail(error instanceof Error ? `review-failed: ${error.message}` : 'review-failed')
      }
    },

    async apply(ownerPanelId, runId) {
      const snapshot = await readyIsolated(ownerPanelId, runId)
      if (snapshot.status !== 'ready') fail('coding-agent-not-ready')
      if (snapshot.appliedToBranch) fail('coding-agent-already-applied')
      let message: string | null = null
      try {
        const first = await review(snapshot.worktreeId)
        if (!first.canApply) message = first.message ?? 'coding-agent-not-ready-to-apply'
        else {
          // Readiness is checked again right before merging: the user may
          // have switched the target branch since the review.
          const again = await review(snapshot.worktreeId)
          if (!again.canApply) message = again.message ?? 'This worker is not ready to apply.'
          else if (again.baseBranch !== first.baseBranch) {
            message = `The current branch changed from ${first.baseBranch} to ${again.baseBranch}. Review again before applying.`
          } else {
            const merged = await deps.worktrees.merge(again.branch, again.baseBranch)
            if (!merged.ok) message = merged.message
            else put({ ...runs.get(runId)!, appliedAt: now(), appliedToBranch: again.baseBranch })
          }
        }
      } catch (error) {
        return fail(error instanceof Error ? `apply-failed: ${error.message}` : 'apply-failed')
      }
      if (message) fail(message)
      return current(runId)
    },

    async keep(ownerPanelId, runId) {
      const snapshot = await readyIsolated(ownerPanelId, runId)
      if (snapshot.status !== 'ready') fail('coding-agent-not-ready')
      put({ ...runs.get(runId)!, keptAt: now() })
      return current(runId)
    },

    async discard(ownerPanelId, runId) {
      const snapshot = await readyIsolated(ownerPanelId, runId)
      if (!snapshot.ownsWorktree) fail('worker-does-not-own-worktree')
      if (snapshot.status !== 'ready') fail('coding-agent-not-ready')
      try {
        const status = await deps.worktrees.status(snapshot.worktreeId)
        if (!status) throw new Error('worktree-not-found')
        await deps.worktrees.remove(snapshot.worktreeId, { force: status.dirty, deleteBranch: true })
      } catch (error) {
        return fail(error instanceof Error ? `discard-failed: ${error.message}` : 'discard-failed')
      }
      const { worktreeId: _removed, ...rest } = runs.get(runId)!
      put({ ...rest, ownsWorktree: false })
      return current(runId)
    },

    async stop(ownerPanelId, runId) {
      const run = ownedRun(ownerPanelId, runId)
      if (!run) fail('coding-agent-not-found')
      deps.terminals.terminate(run!.panelId)
      put({ ...runs.get(runId)!, stoppedAt: now() })
      return current(runId)
    },

    stopAll(ownerPanelId) {
      stoppedOwners.add(ownerPanelId)
      let stopped = 0
      for (const run of allOwned(ownerPanelId)) {
        if (run.endedAt) continue
        const alive = deps.terminals.state(run.panelId).alive
        if (alive) deps.terminals.terminate(run.panelId)
        if (!run.stoppedAt) put({ ...run, stoppedAt: now() })
        if (alive || !run.stoppedAt) stopped++
      }
      return { stopped }
    },

    async snapshot(ownerPanelId, runId) {
      const run = ownedRun(ownerPanelId, runId)
      return run ? snapshotOf(run) : null
    },

    interactionTargets(ownerPanelId, method, args) {
      const name = method.slice('cate.codingAgent.'.length)
      if (name === 'create' || name === 'list') return []
      const runIds = name === 'wait'
        ? Array.isArray(args.runIds) ? args.runIds.filter((id): id is string => typeof id === 'string') : []
        : typeof args.runId === 'string' ? [args.runId] : []
      if (name === 'wait' && runIds.length === 0) return allOwned(ownerPanelId).map((run) => run.panelId)
      return runIds.flatMap((runId) => {
        const run = ownedRun(ownerPanelId, runId)
        return run ? [run.panelId] : []
      })
    },

    noteExit(panelId, exitCode) {
      const run = runOfPanel(panelId)
      if (!run || run.stoppedAt || run.endedAt) return
      put({ ...run, endedAt: now(), exitCode })
    },

    onChange(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },

    notifyChanged: changed,
  }
}
