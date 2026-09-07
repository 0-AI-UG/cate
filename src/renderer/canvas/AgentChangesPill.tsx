import React, { useState } from 'react'
import { GitDiff } from '@phosphor-icons/react'
import type { PanelState } from '../../shared/types'
import { useAppStore } from '../stores/appStore'
import { openAgentChanges } from '../lib/review/openAgentChanges'

export function AgentChangesPill({ panel, workspaceId }: { panel: PanelState; workspaceId: string }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return <>
    <button type="button" aria-label="Open agent changes" title={error || 'Changes from this panel'} disabled={busy}
      className="group inline-flex h-[18px] items-center gap-1 rounded-full bg-surface-3 px-1 text-secondary hover:text-primary disabled:opacity-50"
      onMouseDown={(event) => event.stopPropagation()}
      onClick={async (event) => {
        event.stopPropagation()
        if (busy) return
        const workspace = useAppStore.getState().getWorkspace(workspaceId)
        const cwd = panel.cwd ?? workspace?.worktrees?.find((w) => w.id === panel.worktreeId)?.path ?? workspace?.rootPath
        if (!cwd) return
        setBusy(true); setError('')
        try { await openAgentChanges({ workspaceId, panelId: panel.id, cwd }) }
        catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not open agent changes') }
        finally { setBusy(false) }
      }}>
      <GitDiff size={11} />
      <span className="max-w-0 overflow-hidden text-[10px] transition-all group-hover:max-w-20">Changes</span>
    </button>
    {error && <span role="alert" className="max-w-48 rounded bg-surface-2 px-2 text-[10px] text-red-400">{error}</span>}
  </>
}
