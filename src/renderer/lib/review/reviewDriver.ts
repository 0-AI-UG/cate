import type { GitReviewNote, ReviewPanelState } from '../../../shared/types'
import { useAppStore } from '../../stores/appStore'

export type ReviewOutcome = { ok: true; result?: unknown } | { ok: false; error: string }

function reviewPanel(workspaceId: string, panelId: unknown) {
  if (typeof panelId !== 'string') return null
  const panel = useAppStore.getState().workspaces
    .find((workspace) => workspace.id === workspaceId)?.panels[panelId]
  return panel?.type === 'review' && panel.reviewState ? panel : null
}

function contextHash(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function persist(workspaceId: string, panelId: string, state: ReviewPanelState): void {
  useAppStore.getState().setPanelReviewState(workspaceId, panelId, state)
}

export async function handleReviewMethod(
  workspaceId: string,
  callerPanelId: string,
  method: string,
  args: Record<string, unknown>,
): Promise<ReviewOutcome> {
  const panel = reviewPanel(workspaceId, args.panelId)
  if (!panel?.reviewState) return { ok: false, error: 'review-panel-not-found' }
  const panelId = panel.id
  const state = panel.reviewState
  const name = method.slice('cate.review.'.length)

  if (name === 'inspect') {
    const comparison = await window.electronAPI.gitCompare(state.repoPath, state.spec, workspaceId)
    return {
      ok: true,
      result: {
        panelId,
        repoPath: state.repoPath,
        spec: state.spec,
        resolvedBase: comparison.resolvedBase,
        resolvedTarget: comparison.resolvedTarget,
        files: comparison.files,
        notes: state.notes ?? [],
      },
    }
  }

  if (name === 'note.add') {
    const file = typeof args.file === 'string' ? args.file : ''
    const body = typeof args.body === 'string' ? args.body.trim() : ''
    const side = args.side === 'old' || args.side === 'new' ? args.side : null
    const line = typeof args.line === 'number' && Number.isInteger(args.line) && args.line > 0 ? args.line : null
    const severity = args.severity === 'info' || args.severity === 'error' ? args.severity : 'warning'
    if (!file) return { ok: false, error: 'file-required' }
    if (!body) return { ok: false, error: 'body-required' }
    if (!side) return { ok: false, error: 'invalid-side' }
    if (line === null) return { ok: false, error: 'line-required' }

    const comparison = await window.electronAPI.gitCompare(state.repoPath, state.spec, workspaceId)
    if (!comparison.files.some((candidate) => candidate.path === file)) {
      return { ok: false, error: 'file-not-in-review' }
    }
    const diff = await window.electronAPI.gitFileDiff(
      state.repoPath,
      state.spec,
      file,
      { contextLines: 3, allowLarge: true },
      workspaceId,
    )
    const matching = diff.hunks.flatMap((hunk) => hunk.lines).find((candidate) =>
      (side === 'old' ? candidate.oldLine : candidate.newLine) === line,
    )
    if (!matching) return { ok: false, error: 'line-not-in-diff' }
    const context = matching.text
    const callerRun = useAppStore.getState().workspaces
      .find((workspace) => workspace.id === workspaceId)?.panels[callerPanelId]?.codingAgentRun
    const note: GitReviewNote = {
      id: crypto.randomUUID(),
      path: file,
      side,
      line,
      body,
      context,
      contextHash: contextHash(context),
      resolvedBase: comparison.resolvedBase,
      resolvedTarget: comparison.resolvedTarget,
      status: 'open',
      severity,
      author: 'agent',
      agentRunId: callerRun?.id,
      createdAt: new Date().toISOString(),
    }
    persist(workspaceId, panelId, { ...state, notes: [...(state.notes ?? []), note] })
    return { ok: true, result: note }
  }

  if (name === 'note.resolve') {
    const prefix = typeof args.noteId === 'string' ? args.noteId : ''
    if (!prefix) return { ok: false, error: 'note-id-required' }
    const matches = (state.notes ?? []).filter((note) => note.id === prefix || note.id.startsWith(prefix))
    if (matches.length === 0) return { ok: false, error: 'review-note-not-found' }
    if (matches.length > 1) return { ok: false, error: 'ambiguous-review-note' }
    persist(workspaceId, panelId, {
      ...state,
      notes: (state.notes ?? []).map((note) => note.id === matches[0].id ? { ...note, status: 'resolved' } : note),
    })
    return { ok: true, result: { noteId: matches[0].id, status: 'resolved' } }
  }

  if (name === 'complete') {
    const callerRun = useAppStore.getState().workspaces
      .find((workspace) => workspace.id === workspaceId)?.panels[callerPanelId]?.codingAgentRun
    const assigned = state.agentReview
    if (
      !callerRun
      || callerRun.ownerPanelId !== panelId
      || (assigned && (assigned.terminalPanelId !== callerPanelId || assigned.runId !== callerRun.id))
    ) {
      return { ok: false, error: 'review-agent-mismatch' }
    }
    persist(workspaceId, panelId, {
      ...state,
      agentReview: {
        runId: callerRun.id,
        terminalPanelId: callerPanelId,
        startedAt: assigned?.startedAt ?? callerRun.createdAt,
        status: 'complete',
        completedAt: Date.now(),
      },
    })
    return { ok: true, result: { status: 'complete' } }
  }

  return { ok: false, error: 'unsupported' }
}
