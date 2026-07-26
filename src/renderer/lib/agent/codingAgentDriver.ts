import { useAppStore } from '../../stores/appStore'
import { useStatusStore } from '../../stores/statusStore'
import { terminalRegistry } from '../terminal/terminalRegistry'
import { placementForBackgroundPanel } from '../workspace/canvasAccess'
import { parseLocator, formatLocator } from '../../../shared/runtimeLocator'
import { pathKey } from '../../../shared/pathUtils'
import { createWorktreeForWorkspace } from '../../stores/useWorktreeActions'
import {
  MAX_CONCURRENT_CODING_AGENTS,
  codingAgentDisplayName,
  parseCodingAgentId,
  type CodingAgentRun,
  type CodingAgentRunSnapshot,
  type CodingAgentRunStatus,
} from '../../../shared/codingAgentRuns'

export type CodingAgentOutcome =
  | { ok: true; result: unknown }
  | { ok: false; error: string }

function workspace(workspaceId: string) {
  return useAppStore.getState().workspaces.find((candidate) => candidate.id === workspaceId)
}

function runPanel(workspaceId: string, runId: string) {
  const ws = workspace(workspaceId)
  return Object.values(ws?.panels ?? {}).find((panel) => panel.codingAgentRun?.id === runId)
}

function terminalText(panelId: string, maxChars = 4_000): string {
  const terminal = terminalRegistry.getEntry(panelId)?.terminal
  if (!terminal) return ''
  const buffer = terminal.buffer.active
  const lines: string[] = []
  for (let index = 0; index < buffer.length; index++) {
    lines.push(buffer.getLine(index)?.translateToString(true) ?? '')
  }
  while (lines.length > 0 && !lines[lines.length - 1]) lines.pop()
  return lines.join('\n').slice(-maxChars)
}

function runStatus(workspaceId: string, panelId: string, run: CodingAgentRun): CodingAgentRunStatus {
  if (run.stoppedAt) return 'stopped'
  if (run.endedAt) return run.exitCode === 0 ? 'ready' : 'failed'
  const failure = terminalRegistry.getFailure(panelId)
  if (failure) return 'failed'
  const entry = terminalRegistry.getEntry(panelId)
  if (!entry) return 'starting'
  if (!entry.alive) return 'ready'
  const runtime = entry.ptyId
    ? useStatusStore.getState().workspaces[workspaceId]?.terminals[entry.ptyId]
    : undefined
  switch (runtime?.agentState) {
    case 'running': return 'working'
    case 'waitingForInput': return 'waiting'
    case 'finished': return 'ready'
    case 'notRunning':
    default:
      return runtime?.agentPresent || runtime?.agentName ? 'working' : 'starting'
  }
}

export function codingAgentSnapshot(
  workspaceId: string,
  runId: string,
): CodingAgentRunSnapshot | null {
  const panel = runPanel(workspaceId, runId)
  const run = panel?.codingAgentRun
  if (!panel || !run) return null
  const entry = terminalRegistry.getEntry(panel.id)
  const output = terminalText(panel.id)
  const lastLine = output.split('\n').reverse().find((line) => line.trim())?.trim()
  return {
    ...run,
    status: runStatus(workspaceId, panel.id, run),
    agentName: codingAgentDisplayName(run.agentId),
    cwd: panel.cwd ?? workspace(workspaceId)?.rootPath ?? '',
    alive: entry?.alive === true,
    followUpSupported: run.agentId !== 'opencode',
    ...(lastLine ? { statusLine: lastLine.slice(0, 200) } : {}),
  }
}

function allSnapshots(workspaceId: string): CodingAgentRunSnapshot[] {
  const ws = workspace(workspaceId)
  return Object.values(ws?.panels ?? {})
    .filter((panel) => panel.codingAgentRun)
    .map((panel) => codingAgentSnapshot(workspaceId, panel.codingAgentRun!.id))
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
  raw: unknown,
): CodingAgentRunSnapshot[] | { error: string } {
  if (raw !== undefined && !Array.isArray(raw)) return { error: 'runIds-must-be-an-array' }
  const ids = raw as unknown[] | undefined
  if (!ids) return allSnapshots(workspaceId)
  const snapshots: CodingAgentRunSnapshot[] = []
  for (const value of ids) {
    if (typeof value !== 'string') return { error: 'invalid-run-id' }
    const snapshot = codingAgentSnapshot(workspaceId, value)
    if (!snapshot) return { error: 'coding-agent-not-found' }
    snapshots.push(snapshot)
  }
  return snapshots
}

export async function handleCodingAgentMethod(
  workspaceId: string,
  method: string,
  args: Record<string, unknown>,
): Promise<CodingAgentOutcome> {
  const name = method.slice('cate.codingAgent.'.length)

  if (name === 'create') {
    const agentId = parseCodingAgentId(args.agentId)
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
    if (!agentId) return { ok: false, error: 'unsupported-agent' }
    if (!prompt) return { ok: false, error: 'prompt-required' }
    if (prompt.includes('\0')) return { ok: false, error: 'invalid-prompt' }
    if (prompt.length > 50_000) return { ok: false, error: 'prompt-too-long' }
    const active = allSnapshots(workspaceId).filter((run) =>
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

    const runId = crypto.randomUUID()
    const placementGroupId = target.worktreeId
      ? `coding-agent:${target.worktreeId}`
      : 'coding-agent:primary'
    const panelId = useAppStore.getState().createTerminal(
      workspaceId,
      undefined,
      undefined,
      placementForBackgroundPanel(workspaceId, placementGroupId),
      target.cwd,
      { runId, agentId, prompt },
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
    return {
      ok: true,
      result: codingAgentSnapshot(workspaceId, runId) ?? {
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
    const snapshot = codingAgentSnapshot(workspaceId, runId)
    if (!snapshot) return { ok: false, error: 'coding-agent-not-found' }
    return {
      ok: true,
      result: { ...snapshot, recentOutput: terminalText(snapshot.panelId) },
    }
  }

  if (name === 'send') {
    const panel = runPanel(workspaceId, runId)
    const run = panel?.codingAgentRun
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
    if (!panel || !run) return { ok: false, error: 'coding-agent-not-found' }
    if (!prompt) return { ok: false, error: 'prompt-required' }
    if (run.stoppedAt) return { ok: false, error: 'coding-agent-stopped' }
    const entry = terminalRegistry.getEntry(panel.id)
    if (!entry?.ptyId || !entry.alive) return { ok: false, error: 'coding-agent-not-ready' }
    entry.terminal.paste(prompt)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    await window.electronAPI.terminalWrite(entry.ptyId, '\r')
    useAppStore.getState().setPanelCodingAgentRun(workspaceId, panel.id, {
      ...run,
      followUps: [...(run.followUps ?? []), { prompt, sentAt: Date.now() }],
    })
    return { ok: true, result: codingAgentSnapshot(workspaceId, runId) }
  }

  if (name === 'stop') {
    const panel = runPanel(workspaceId, runId)
    const run = panel?.codingAgentRun
    if (!panel || !run) return { ok: false, error: 'coding-agent-not-found' }
    terminalRegistry.dispose(panel.id)
    useAppStore.getState().setPanelCodingAgentRun(workspaceId, panel.id, {
      ...run,
      stoppedAt: Date.now(),
    })
    return { ok: true, result: codingAgentSnapshot(workspaceId, runId) }
  }

  if (name === 'wait') {
    const timeout = Math.max(0, Math.min(8_000, Number(args.timeoutSeconds ?? 4) * 1_000))
    const startedAt = Date.now()
    while (true) {
      const snapshots = findRequestedRuns(workspaceId, args.runIds)
      if ('error' in snapshots) return { ok: false, error: snapshots.error }
      const settled = snapshots.some((run) =>
        run.status === 'ready' || run.status === 'waiting' ||
        run.status === 'stopped' || run.status === 'failed',
      )
      if (settled || Date.now() - startedAt >= timeout) {
        return { ok: true, result: { timedOut: !settled, runs: snapshots } }
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 200))
    }
  }

  return { ok: false, error: 'unsupported' }
}
