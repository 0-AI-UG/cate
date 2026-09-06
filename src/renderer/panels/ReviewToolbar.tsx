import React, { useState } from 'react'
import type { GitComparisonSpec, ReviewPanelState } from '../../shared/types'
import { useAppStore } from '../stores/appStore'
import { Spinner } from '../ui/Spinner'

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
    <div className="flex flex-wrap items-center gap-1.5 px-2 py-1.5 border-b border-subtle bg-surface-1 flex-shrink-0">
      <select aria-label="Comparison" value={state.agentChanges ? 'agent' : state.spec.kind} disabled={busy}
        onChange={(event) => void select(event.target.value as typeof MODES[number]['value'])}
        className="h-7 rounded-lg bg-surface-2 border border-subtle px-2 text-[12px] focus:outline-none">
        {MODES.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}
      </select>
      {busy && <Spinner size={14} label="Loading comparison" />}
      {children}
    </div>
    {error && <div role="alert" className="px-3 py-2 text-red-400 text-[11px] border-b border-subtle">{error}</div>}
  </>
}
