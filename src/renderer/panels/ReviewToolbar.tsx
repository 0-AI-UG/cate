import React, { useState } from 'react'
import type { GitComparisonSpec, ReviewPanelState } from '../../shared/types'
import { useAppStore } from '../stores/appStore'
import { Spinner } from '../ui/Spinner'
import { useWorktrees } from '../stores/useWorktrees'
import { WorktreeSelector } from '../ui/WorktreeSelector'
import { worktreeForPath } from '../lib/worktreeContext'

const MODES = [
  { value: 'uncommitted', label: 'All Changes' },
  { value: 'unstaged', label: 'Changes' },
  { value: 'staged', label: 'Staged Changes' },
  { value: 'commit', label: 'Commit' },
  { value: 'branch', label: 'Branch' },
  { value: 'agent', label: 'Agent changes' },
] as const

export function ReviewToolbar({ state, workspaceId, panelId, children }: {
  state: ReviewPanelState; workspaceId: string; panelId: string; children?: React.ReactNode
}) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const workspace = useAppStore((app) => app.workspaces.find((item) => item.id === workspaceId))
  const worktrees = useWorktrees(workspace?.rootPath ?? '', workspaceId)
  const currentWorktree = worktreeForPath(state.repoPath, worktrees)
  const switchWorktree = (id: string) => {
    const target = worktrees.find((worktree) => worktree.id === id && !worktree.isOrphan)
    if (!target || target.path === state.repoPath || busy) return
    const { worktreeStates = {}, ...current } = state
    const restored = worktreeStates[target.path]
    const spec: GitComparisonSpec = state.spec.kind === 'branch'
      ? { ...state.spec, target: target.branch || 'HEAD' }
      : state.spec
    const next: ReviewPanelState = {
      ...(restored ?? { repoPath: target.path, spec, agentChanges: state.agentChanges ? {} : undefined }),
      display: state.display,
      worktreeStates: { ...worktreeStates, [state.repoPath]: current },
    }
    const app = useAppStore.getState()
    app.setPanelReviewState(workspaceId, panelId, next)
    app.setPanelWorktreeId(workspaceId, panelId, target.id)
  }
  const select = async (kind: GitComparisonSpec['kind'] | 'agent') => {
    setError(''); setBusy(true)
    try {
      let spec = state.spec
      const ignoreWhitespace = spec.ignoreWhitespace
      if (kind === 'commit') {
        const commits = await window.electronAPI.gitLog(state.repoPath, 1, workspaceId)
        if (!commits[0]) throw new Error('This repository has no commits yet.')
        spec = { kind, commit: commits[0].hash, ignoreWhitespace }
      } else if (kind === 'branch') {
        const [result, status] = await Promise.all([
          window.electronAPI.gitBranchList(state.repoPath, workspaceId),
          window.electronAPI.gitStatus(state.repoPath, workspaceId),
        ])
        const branches = result.branches
        const current = branches.find((b) => b.current)?.name ?? branches.find((b) => !b.isRemote)?.name
        const base = branches.find((b) => b.name === status.tracking || b.name === `remotes/${status.tracking}`)?.name
          ?? branches.find((b) => b.name === 'main')?.name ?? branches.find((b) => b.name === 'master')?.name
          ?? branches.find((b) => b.name !== current)?.name ?? current
        if (!current || !base) throw new Error('This repository has no branches yet.')
        spec = { kind, base, target: current, ignoreWhitespace }
      } else if (kind !== 'agent') spec = { kind, ignoreWhitespace }
      const app = useAppStore.getState()
      const latest = app.getWorkspace(workspaceId)?.panels[panelId]?.reviewState
      if (latest && latest.repoPath === state.repoPath) app.setPanelReviewState(workspaceId, panelId, {
        ...latest, spec, agentChanges: kind === 'agent' ? latest.agentChanges ?? {} : undefined,
      })
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not change comparison') }
    finally { setBusy(false) }
  }
  return <>
    <div className="review-toolbar-container w-full min-w-0 shrink-0" style={{ containerType: 'inline-size', containerName: 'review-toolbar' }}>
    <div className="review-toolbar min-w-0 flex flex-nowrap items-center gap-1.5 px-2 py-1.5 border-b border-subtle bg-surface-1">
      <select aria-label="Comparison" value={state.agentChanges ? 'agent' : state.spec.kind} disabled={busy}
        onChange={(event) => void select(event.target.value as typeof MODES[number]['value'])}
        className="review-comparison h-7 min-w-0 rounded-lg bg-surface-2 border border-subtle px-2 text-[12px] focus:outline-none">
        {MODES.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}
      </select>
      <div className="review-worktree min-w-0 max-w-40 flex items-center">
        <WorktreeSelector worktrees={worktrees} value={currentWorktree?.id} onChange={switchWorktree} disabled={busy} title="Diff panel worktree" />
      </div>
      {busy && <Spinner size={14} label="Loading comparison" />}
      {children}
    </div>
    </div>
    {error && <div role="alert" className="px-3 py-2 text-red-400 text-[11px] border-b border-subtle">{error}</div>}
  </>
}
