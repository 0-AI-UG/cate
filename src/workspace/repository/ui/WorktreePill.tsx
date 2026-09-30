// The title-bar worktree chip of a panel whose type binds a checkout: which
// parallel branch the panel belongs to. Hover highlights the worktree on the
// canvas; click opens a menu to focus it or switch the panel to another
// checkout. Hidden unless the workspace has two or more worktrees.

import { useCallback, useEffect } from 'react'
import type { PanelRecord } from '@workspace/document/contract'
import { resolveWorktree } from '../contract'
import { useRepositoryUi } from './context'
import { WorktreeSelector } from './WorktreeSelector'
import { useWorktrees, worktreeLabel } from './worktrees'

export function WorktreePill({ panel }: { panel: PanelRecord }) {
  const host = useRepositoryUi()
  const worktrees = useWorktrees()
  const { setHoveredWorktree, focusWorktree, focusedWorktreeId, switchPanelWorktree } = host

  const live = worktrees.filter((worktree) => !worktree.isOrphan)
  const current = resolveWorktree(panel.worktreeId, live) ?? live.find((w) => w.isPrimary) ?? live[0]
  const currentId = current?.id

  // Clear the hover highlight if this chip unmounts while hovered.
  useEffect(() => () => setHoveredWorktree(null), [setHoveredWorktree])

  const changeWorktree = useCallback(async (id: string) => {
    if (!worktrees.some((worktree) => worktree.id === id)) return
    await switchPanelWorktree(panel.id, id)
  }, [worktrees, panel.id, switchPanelWorktree])

  if (!host.bindsWorktree(panel) || live.length < 2 || !current) return null

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
