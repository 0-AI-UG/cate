import { useAppStore } from '../../stores/appStore'
import { useStatusStore } from '../../stores/statusStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { terminalRegistry } from '../terminal/terminalRegistry'
import { terminalBufferTail } from '../terminal/terminalBuffer'
import { submitTerminalText } from '../terminal/terminalDriver'
import { placementForBackgroundPanel } from '../workspace/canvasAccess'
import { parseLocator, formatLocator } from '../../../shared/runtimeLocator'
import { pathKey } from '../../../shared/pathUtils'
import { createWorktreeForWorkspace } from '../../stores/useWorktreeActions'
import {
  MAX_CONCURRENT_CODING_AGENTS,
  codingAgentDisplayName,
  codingAgentSupportsFollowUp,
  deriveCodingAgentRunStatus,
  parseCodingAgentId,
  type CodingAgentRun,
  type CodingAgentRunSnapshot,
  type CodingAgentRunStatus,
} from '../../../shared/codingAgentRuns'
import { resolveDriverAgentCli } from './agentCliHooks'
import type { AgentId } from '../../../shared/agents'
import {
  actionableCodingAgentRunIds,
  changedCodingAgentRunIds,
  codingAgentWaitMs,
  compactCodingAgentSnapshot,
} from './codingAgentWait'

export type CodingAgentOutcome =
  | { ok: true; result: unknown }
  | { ok: false; error: string }

function workspace(workspaceId: string) {
  return useAppStore.getState().workspaces.find((candidate) => candidate.id === workspaceId)
}

function runPanel(workspaceId: string, ownerPanelId: string, runId: string) {
  const ws = workspace(workspaceId)
  return Object.values(ws?.panels ?? {}).find((panel) =>
    panel.codingAgentRun?.id === runId &&
    panel.codingAgentRun.ownerPanelId === ownerPanelId,
  )
}

function terminalText(panelId: string, maxChars = 4_000): string {
  const terminal = terminalRegistry.getEntry(panelId)?.terminal
  return terminal ? terminalBufferTail(terminal, maxChars) : ''
}

function runStatus(workspaceId: string, panelId: string, run: CodingAgentRun): CodingAgentRunStatus {
  const failure = terminalRegistry.getFailure(panelId)
  const entry = terminalRegistry.getEntry(panelId)
  const runtime = entry?.ptyId
    ? useStatusStore.getState().workspaces[workspaceId]?.terminals[entry.ptyId]
    : undefined
  return deriveCodingAgentRunStatus(run, {
    terminalStarted: entry !== undefined,
    terminalAlive: entry?.alive === true,
    terminalFailed: failure !== null,
    agentState: runtime?.agentState,
    agentPresent: runtime?.agentPresent === true || Boolean(runtime?.agentName),
  })
}

export function codingAgentSnapshot(
  workspaceId: string,
  ownerPanelId: string,
  runId: string,
): CodingAgentRunSnapshot | null {
  const panel = runPanel(workspaceId, ownerPanelId, runId)
  const run = panel?.codingAgentRun
  if (!panel || !run) return null
  const entry = terminalRegistry.getEntry(panel.id)
  const output = terminalText(panel.id)
  const lastLine = output.split('\n').reverse().find((line) => line.trim())?.trim()
  const status = runStatus(workspaceId, panel.id, run)
  const terminalFailure = terminalRegistry.getFailure(panel.id)
  const failureDiagnostic = status === 'failed'
    ? output
        .split('\n')
        .reverse()
        .map((line) => line.trim())
        .find((line) => line && !/^\[Process exited with code \d+\]$/.test(line))
    : undefined
  const failureReason = terminalFailure
    ? terminalFailure.slice(0, 500)
    : status === 'failed'
      ? `Process exited with code ${run.exitCode ?? 'unknown'}${failureDiagnostic ? `: ${failureDiagnostic}` : ''}`.slice(0, 500)
      : undefined
  return {
    ...run,
    status,
    agentName: codingAgentDisplayName(run.agentId),
    cwd: panel.cwd ?? workspace(workspaceId)?.rootPath ?? '',
    alive: entry?.alive === true,
    followUpSupported: codingAgentSupportsFollowUp(run.agentId),
    ...(lastLine ? { statusLine: lastLine.slice(0, 200) } : {}),
    ...(failureReason ? { failureReason } : {}),
  }
}

function allSnapshots(workspaceId: string, ownerPanelId: string): CodingAgentRunSnapshot[] {
  const ws = workspace(workspaceId)
  return Object.values(ws?.panels ?? {})
    .filter((panel) => panel.codingAgentRun?.ownerPanelId === ownerPanelId)
    .map((panel) => codingAgentSnapshot(workspaceId, ownerPanelId, panel.codingAgentRun!.id))
    .filter((snapshot): snapshot is CodingAgentRunSnapshot => snapshot !== null)
    .sort((a, b) => a.createdAt - b.createdAt)
}

function runtimeLocatorForPath(rootLocator: string, candidate: string): string {
  const root = parseLocator(rootLocator)
  const parsed = parseLocator(candidate)
  // Worktree metadata may store a bare host path. Keep it on the workspace's
  // runtime rather than accidentally treating it as a local path.
  return formatLocator({
    runtimeId: parsed.runtimeId === 'local' ? root.runtimeId : parsed.runtimeId,
    path: parsed.path,
  })
}

function resolveTarget(
  workspaceId: string,
  args: Record<string, unknown>,
): { cwd: string; worktreeId?: string } | { error: string } {
  const ws = workspace(workspaceId)
  if (!ws?.rootPath) return { error: 'workspace-not-found' }
  const worktrees = ws.worktrees ?? []
  const requested = typeof args.worktreeId === 'string' ? args.worktreeId : undefined
  if (requested) {
    const worktree = worktrees.find((candidate) => candidate.id === requested)
    if (!worktree) return { error: 'worktree-not-registered' }
    return { cwd: runtimeLocatorForPath(ws.rootPath, worktree.path), worktreeId: worktree.id }
  }

  const origin = typeof args._cateOriginCwd === 'string' ? args._cateOriginCwd : ''
  const rootPath = parseLocator(ws.rootPath).path
  if (origin && pathKey(origin) === pathKey(rootPath)) return { cwd: ws.rootPath }
  const inherited = worktrees.find((candidate) =>
    pathKey(parseLocator(candidate.path).path) === pathKey(origin),
  )
  if (inherited) {
    return { cwd: runtimeLocatorForPath(ws.rootPath, inherited.path), worktreeId: inherited.id }
  }
  return { cwd: ws.rootPath }
}

function findRequestedRuns(
  workspaceId: string,
  ownerPanelId: string,
  raw: unknown,
): CodingAgentRunSnapshot[] | { error: string } {
  if (raw !== undefined && !Array.isArray(raw)) return { error: 'runIds-must-be-an-array' }
  const ids = raw as unknown[] | undefined
  if (!ids) return allSnapshots(workspaceId, ownerPanelId)
  const snapshots: CodingAgentRunSnapshot[] = []
  for (const value of ids) {
    if (typeof value !== 'string') return { error: 'invalid-run-id' }
    const snapshot = codingAgentSnapshot(workspaceId, ownerPanelId, value)
    if (!snapshot) return { error: 'coding-agent-not-found' }
    snapshots.push(snapshot)
  }
  return snapshots
}

async function waitForCodingAgentChange(
  workspaceId: string,
  ownerPanelId: string,
  rawRunIds: unknown,
  timeoutMs: number,
): Promise<CodingAgentOutcome> {
  const initial = findRequestedRuns(workspaceId, ownerPanelId, rawRunIds)
  if ('error' in initial) return { ok: false, error: initial.error }
  // With no explicit target, monitor only live mission work. Historical ready
  // runs must not make every future wait return immediately.
  const watched = rawRunIds === undefined
    ? initial.filter((run) =>
        run.status === 'starting' || run.status === 'working' || run.status === 'waiting')
    : initial
  if (watched.length === 0) {
    return { ok: true, result: { timedOut: false, changedRunIds: [], runs: [] } }
  }
  const actionable = actionableCodingAgentRunIds(watched)
  if (actionable.length > 0) {
    return {
      ok: true,
      result: {
        timedOut: false,
        changedRunIds: actionable,
        runs: watched.map(compactCodingAgentSnapshot),
      },
    }
  }
  const ids = watched.map((run) => run.id)
  const baseline = new Map(watched.map((run) => [run.id, run.status]))

  return new Promise<CodingAgentOutcome>((resolve) => {
    let settled = false
    let unsubscribeApp = () => {}
    let unsubscribeStatus = () => {}
    let unsubscribeFailure = () => {}

    const finish = (outcome: CodingAgentOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      unsubscribeApp()
      unsubscribeStatus()
      unsubscribeFailure()
      resolve(outcome)
    }
    const current = (): CodingAgentRunSnapshot[] | { error: string } =>
      findRequestedRuns(workspaceId, ownerPanelId, ids)
    const check = (): void => {
      const snapshots = current()
      if ('error' in snapshots) {
        finish({ ok: false, error: snapshots.error })
        return
      }
      const changedRunIds = changedCodingAgentRunIds(baseline, snapshots)
      if (changedRunIds.length > 0) {
        finish({
          ok: true,
          result: {
            timedOut: false,
            changedRunIds,
            runs: snapshots.map(compactCodingAgentSnapshot),
          },
        })
      }
    }

    const timer = setTimeout(() => {
      const snapshots = current()
      finish('error' in snapshots
        ? { ok: false, error: snapshots.error }
        : {
            ok: true,
            result: {
              timedOut: true,
              changedRunIds: [],
              runs: snapshots.map(compactCodingAgentSnapshot),
            },
          })
    }, timeoutMs)
    unsubscribeApp = useAppStore.subscribe(check)
    unsubscribeStatus = useStatusStore.subscribe(check)
    unsubscribeFailure = terminalRegistry.subscribeFailure(check)
    // Close the gap between the initial snapshot and listener registration.
    check()
  })
}

export async function handleCodingAgentMethod(
  workspaceId: string,
  ownerPanelId: string,
  method: string,
  args: Record<string, unknown>,
): Promise<CodingAgentOutcome> {
  const name = method.slice('cate.codingAgent.'.length)
  if (!ownerPanelId) return { ok: false, error: 'mission-owner-required' }

  if (name === 'create') {
    const requestedAgentId = args.agentId === undefined ? '' : parseCodingAgentId(args.agentId)
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
    if (args.agentId !== undefined && !requestedAgentId) {
      return { ok: false, error: 'unsupported-agent' }
    }
    if (!prompt) return { ok: false, error: 'prompt-required' }
    if (prompt.includes('\0')) return { ok: false, error: 'invalid-prompt' }
    if (prompt.length > 50_000) return { ok: false, error: 'prompt-too-long' }
    const active = allSnapshots(workspaceId, ownerPanelId).filter((run) =>
      run.status === 'starting' || run.status === 'working' || run.status === 'waiting',
    )
    if (active.length >= MAX_CONCURRENT_CODING_AGENTS) {
      return { ok: false, error: 'coding-agent-limit' }
    }
    if (args.worktreeId && args.newWorktree) {
      return { ok: false, error: 'choose-worktreeId-or-newWorktree' }
    }
    if (typeof args.newWorktree === 'string' && args.newWorktree.trim()) {
      const ws = workspace(workspaceId)
      if (!ws?.rootPath) return { ok: false, error: 'workspace-not-found' }
      try {
        const created = await createWorktreeForWorkspace(
          ws.rootPath,
          workspaceId,
          args.newWorktree,
          typeof args.baseRef === 'string' ? args.baseRef : undefined,
        )
        args = { ...args, worktreeId: created.id }
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? `worktree-create-failed: ${error.message}` : 'worktree-create-failed',
        }
      }
    }
    const target = resolveTarget(workspaceId, args)
    if ('error' in target) return { ok: false, error: target.error }
    const ws = workspace(workspaceId)
    let agentId: AgentId
    try {
      const agent = await resolveDriverAgentCli(target.cwd, requestedAgentId || '', {
        fallbackLocator: ws?.rootPath,
        hookConfig: useSettingsStore.getState().agentHookInjection[workspaceId],
      })
      agentId = agent.id
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error
          ? `agent-hooks-not-ready: ${error.message}`
          : 'agent-hooks-not-ready',
      }
    }

    const runId = crypto.randomUUID()
    const placementGroupId = target.worktreeId
      ? `coding-agent:${target.worktreeId}`
      : 'coding-agent:primary'
    const launch = { runId, agentId, prompt, ownerPanelId }
    const panelId = useAppStore.getState().createTerminal(
      workspaceId,
      undefined,
      undefined,
      placementForBackgroundPanel(workspaceId, placementGroupId),
      target.cwd,
      launch,
    )
    if (!panelId) return { ok: false, error: 'panel-creation-failed' }
    const store = useAppStore.getState()
    if (target.worktreeId) store.setPanelWorktreeId(workspaceId, panelId, target.worktreeId)
    const panel = workspace(workspaceId)?.panels[panelId]
    if (panel?.codingAgentRun) {
      store.setPanelCodingAgentRun(workspaceId, panelId, {
        ...panel.codingAgentRun,
        worktreeId: target.worktreeId,
      })
    }
    const label = prompt.replace(/\s+/g, ' ').slice(0, 54)
    store.updatePanelTitle(workspaceId, panelId, `${codingAgentDisplayName(agentId)} · ${label}`)

    // Mission workers are processes, not a React mount side effect. Starting
    // the existing terminal lifecycle here keeps them alive in inactive
    // workspaces/canvases; TerminalPanel later attaches to the same entry.
    await terminalRegistry.getOrCreate(panelId, {
      workspaceId,
      cwd: target.cwd,
      codingAgentLaunch: launch,
      placementGroupId,
    })
    const snapshot = codingAgentSnapshot(workspaceId, ownerPanelId, runId)
    return {
      ok: true,
      result: snapshot ? compactCodingAgentSnapshot(snapshot) : {
        id: runId,
        panelId,
        agentId,
        status: 'starting',
      },
    }
  }

  const runId = typeof args.runId === 'string' ? args.runId : ''
  if (name !== 'wait' && !runId) return { ok: false, error: 'runId-required' }

  if (name === 'inspect') {
    const snapshot = codingAgentSnapshot(workspaceId, ownerPanelId, runId)
    if (!snapshot) return { ok: false, error: 'coding-agent-not-found' }
    return {
      ok: true,
      result: {
        ...compactCodingAgentSnapshot(snapshot),
        recentOutput: terminalText(snapshot.panelId),
      },
    }
  }

  if (name === 'send') {
    const panel = runPanel(workspaceId, ownerPanelId, runId)
    const run = panel?.codingAgentRun
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
    if (!panel || !run) return { ok: false, error: 'coding-agent-not-found' }
    if (!prompt) return { ok: false, error: 'prompt-required' }
    if (run.stoppedAt) return { ok: false, error: 'coding-agent-stopped' }
    if (!codingAgentSupportsFollowUp(run.agentId)) {
      return { ok: false, error: 'coding-agent-follow-up-unsupported' }
    }
    if (!(await submitTerminalText(panel.id, prompt))) {
      return { ok: false, error: 'coding-agent-not-ready' }
    }
    useAppStore.getState().setPanelCodingAgentRun(workspaceId, panel.id, {
      ...run,
      followUps: [...(run.followUps ?? []), { prompt, sentAt: Date.now() }],
    })
    const snapshot = codingAgentSnapshot(workspaceId, ownerPanelId, runId)
    return { ok: true, result: snapshot ? compactCodingAgentSnapshot(snapshot) : null }
  }

  if (name === 'stop') {
    const panel = runPanel(workspaceId, ownerPanelId, runId)
    const run = panel?.codingAgentRun
    if (!panel || !run) return { ok: false, error: 'coding-agent-not-found' }
    terminalRegistry.terminate(panel.id)
    useAppStore.getState().setPanelCodingAgentRun(workspaceId, panel.id, {
      ...run,
      stoppedAt: Date.now(),
    })
    const snapshot = codingAgentSnapshot(workspaceId, ownerPanelId, runId)
    return { ok: true, result: snapshot ? compactCodingAgentSnapshot(snapshot) : null }
  }

  if (name === 'wait') {
    return waitForCodingAgentChange(
      workspaceId,
      ownerPanelId,
      args.runIds,
      codingAgentWaitMs(args.timeoutSeconds),
    )
  }

  return { ok: false, error: 'unsupported' }
}
