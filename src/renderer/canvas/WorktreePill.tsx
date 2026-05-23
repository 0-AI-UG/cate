// =============================================================================
// WorktreePill — compact title-bar control that shows which "parallel branch"
// a terminal or agent panel is associated with. Click to switch.
//
// Hidden unless the workspace has 2+ worktrees; otherwise it would just be
// chrome noise on the most common (single-branch) flow.
// =============================================================================

import React, { useCallback } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../stores/appStore'
import { terminalRegistry } from '../lib/terminalRegistry'
import type { PanelState } from '../../shared/types'

interface WorktreePillProps {
  panel: PanelState
  /** Workspace id — passed in so the pill can write through the store. */
  workspaceId: string
}

export const WorktreePill: React.FC<WorktreePillProps> = ({ panel, workspaceId }) => {
  const worktrees = useAppStore(useShallow((s) => s.workspaces.find((w) => w.id === workspaceId)?.worktrees ?? []))
  const setPanelWorktreeId = useAppStore((s) => s.setPanelWorktreeId)

  const current = worktrees.find((w) => w.id === panel.worktreeId) ?? worktrees.find((w) => w.isPrimary)

  const handleClick = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!window.electronAPI || !current) return
    const items = worktrees.map((w) => ({
      id: w.id,
      label: (w.label || w.branch || (w.isPrimary ? 'main' : '(detached)')) + (w.id === current.id ? '  ✓' : ''),
    }))
    const choice = await window.electronAPI.showContextMenu(items)
    if (!choice || choice === current.id) return
    const target = worktrees.find((w) => w.id === choice)
    if (!target) return

    setPanelWorktreeId(workspaceId, panel.id, target.id)

    // For terminals, also `cd` into the new path so the shell follows the
    // visual change. Keeps history intact.
    if (panel.type === 'terminal') {
      const entry = terminalRegistry.getEntry(panel.id)
      if (entry?.ptyId) {
        // Escape single quotes by closing/reopening the quoted segment.
        const safe = target.path.replace(/'/g, `'\\''`)
        window.electronAPI.terminalWrite(entry.ptyId, ` cd '${safe}'\r`)
      }
    }
    // For agent panels we only update the tag — the pi process's cwd is set
    // at spawn time, so a true switch would require teardown. The sidebar's
    // "open agent here" button is the right way to start fresh in a worktree.
  }, [worktrees, current, panel, workspaceId, setPanelWorktreeId])

  // Only relevant for terminal/agent panels in workspaces with 2+ worktrees.
  if (panel.type !== 'terminal' && panel.type !== 'agent') return null
  if (worktrees.length < 2 || !current) return null

  return (
    <button
      type="button"
      onClick={handleClick}
      title={`Worktree: ${current.branch || current.path}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        height: 18,
        padding: '0 6px',
        borderRadius: 9,
        backgroundColor: `color-mix(in srgb, ${current.color} 18%, transparent)`,
        border: `1px solid color-mix(in srgb, ${current.color} 45%, transparent)`,
        color: 'var(--text-secondary)',
        fontSize: 10,
        lineHeight: 1,
        cursor: 'pointer',
        userSelect: 'none',
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          backgroundColor: current.color,
          flexShrink: 0,
        }}
      />
      <span style={{ maxWidth: 80, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {current.label || current.branch || (current.isPrimary ? 'main' : 'wt')}
      </span>
    </button>
  )
}
