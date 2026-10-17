// Git tint for file views, over repository/ui's shared git status store.

import { useMemo } from 'react'
import { useGitStatus } from '../repository'
import { buildGitTreeDecorations, type GitTree } from './gitStatusDecoration'

/** The file-tree decorations for `rootPath`, undefined outside a repo. */
export function useGitTree(workspaceId: string | null | undefined, rootPath: string): GitTree | undefined {
  const snap = useGitStatus(workspaceId, rootPath)
  return useMemo(() => {
    if (!snap.isRepo) return undefined
    return { tracked: snap.tracked as Set<string>, decorations: buildGitTreeDecorations(snap.files, rootPath) }
    // revision changes whenever files/tracked change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootPath, snap.revision, snap.isRepo])
}
