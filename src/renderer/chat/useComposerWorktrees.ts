// =============================================================================
// useComposerWorktrees — the worktree menu data every chat composer shares.
//
// One place for the read-time worktree join (orphans dropped, they aren't
// pickable) plus the two id-returning adapters the ChatComposer's create/checkout
// menus expect. Editability (onPickWorktree / selectedWorktreeId) is NOT baked in
// here: the sidebar coding path makes the pill read-only while the panel and loop
// make it editable, so each surface still owns that pair.
// =============================================================================

import { useCallback, useMemo } from 'react'
import { useWorktrees, type JoinedWorktree } from '../stores/useWorktrees'
import { useWorktreeActions, type WorktreeActions } from '../stores/useWorktreeActions'
import type { PrListItem } from '../sidebar/CreateWorktreeForm'

export interface ComposerWorktrees {
  worktrees: JoinedWorktree[]
  onCreateWorktree: (name: string, baseRef?: string) => Promise<string | null>
  onCheckoutPr: (pr: PrListItem) => Promise<string | null>
  createWorktree: WorktreeActions['createWorktree']
  checkoutPr: WorktreeActions['checkoutPr']
}

export function useComposerWorktrees({
  rootPath,
  workspaceId,
}: {
  rootPath: string
  workspaceId: string
}): ComposerWorktrees {
  const joined = useWorktrees(rootPath, workspaceId)
  const worktrees = useMemo(() => joined.filter((w) => !w.isOrphan), [joined])
  const { createWorktree, checkoutPr } = useWorktreeActions(rootPath, workspaceId)

  const onCreateWorktree = useCallback(
    async (name: string, baseRef?: string) => (await createWorktree(name, baseRef))?.id ?? null,
    [createWorktree],
  )
  const onCheckoutPr = useCallback(
    async (pr: PrListItem) => (await checkoutPr(pr))?.id ?? null,
    [checkoutPr],
  )

  return { worktrees, onCreateWorktree, onCheckoutPr, createWorktree, checkoutPr }
}
