// =============================================================================
// WorktreePill: the terminal/Agent title-bar "worktree chip" shows which
// parallel branch a worktree-bound panel belongs to.
//
//   • Hover  → highlights every node in that worktree (ring + sludge boost).
//   • Click  → menu: focus the worktree on canvas, or switch this panel to
//              another worktree. Switching opens a fresh PTY in the new
//              checkout because a terminal is bound to its checkout.
//
// Hidden unless the workspace has 2+ worktrees — otherwise it's just chrome
// noise on the common single-branch flow.
// =============================================================================

import React, { useCallback, useEffect } from 'react'
import { WorktreeSelector, worktreeLabel } from '../ui/WorktreeSelector'
import { useAppStore } from '../stores/appStore'
import { useUIStore } from '../stores/uiStore'
import { useWorktrees } from '../stores/useWorktrees'
import { confirmCloseRunningTerminals } from '../lib/confirmCloseTerminal'
import { resolveWorktree } from '../../shared/worktrees'
import type { PanelState } from '../../shared/types'

interface WorktreePillProps {
  panel: PanelState
  /** Workspace id — passed in so the pill can write through the store. */
  workspaceId: string
}

export const WorktreePill: React.FC<WorktreePillProps> = ({ panel, workspaceId }) => {
  // Live-git facts (branch/isPrimary) joined with persisted UI metadata
  // (color/label), the single source shared with the Parallel Work tab.
  const rootPath = useAppStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.rootPath ?? '')
  const worktrees = useWorktrees(rootPath, workspaceId)
  const setHoveredWorktree = useUIStore((s) => s.setHoveredWorktree)
  const focusWorktree = useUIStore((s) => s.focusWorktree)
  const focusedWorktreeId = useUIStore((s) => s.focusedWorktreeId)

  const live = worktrees.filter((worktree) => !worktree.isOrphan)
  const current = resolveWorktree(panel.worktreeId, live) ?? live.find((w) => w.isPrimary) ?? live[0]
  const currentId = current?.id

  // Clear the hover highlight if this chip unmounts while hovered.
  useEffect(() => () => setHoveredWorktree(null), [setHoveredWorktree])

  const changeWorktree = useCallback(async (id: string) => {
    const target = worktrees.find((worktree) => worktree.id === id)
    if (!target) return

    if (panel.type === 'agent') {
      useAppStore.getState().setPanelWorktreeId(workspaceId, panel.id, target.id)
      return
    }

    // A terminal is bound to a checkout. Switching means a fresh shell in the
    // new path, so warn first if a foreground process is running.
    const ok = await confirmCloseRunningTerminals([panel])
    if (!ok) return
    useAppStore.getState().respawnPanelTerminal(workspaceId, panel.id, target.path, target.id)
  }, [worktrees, panel, workspaceId])

  if (panel.type !== 'terminal' && panel.type !== 'agent') return null
  if (live.length < 2 || !current) return null

  const isFocused = focusedWorktreeId === currentId

  return <WorktreeSelector
    worktrees={worktrees}
    value={currentId}
    onChange={changeWorktree}
    title="Worktree"
    overlay
    focused={isFocused}
    onHoverChange={setHoveredWorktree}
    focusAction={{
      label: isFocused ? 'Clear focus' : `Focus “${worktreeLabel(current)}” on canvas`,
      onSelect: () => focusWorktree(isFocused ? null : current.id),
    }}
  />
}
