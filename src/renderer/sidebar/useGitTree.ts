// =============================================================================
// useGitTree — load the repo's git decorations (the same GitTree the Explorer
// builds) for any view that wants to tint paths by git status. Used by the
// Search view so result file rows decorate consistently with the file tree.
//
// This is now a thin re-export over the single per-workspace gitStatusStore:
// the Explorer, the Search view and Source Control all read the same snapshot
// (one fsWatch + focus + branch-update loop), so they can no longer show three
// different snapshots of the same repo at once. The previous self-contained
// fetch + watch + debounce loop has been deleted in favor of useGitTreeFor.
// =============================================================================

import type { GitTree } from './gitStatusDecoration'
import { useGitTreeFor } from '../stores/gitStatusStore'

/** React hook returning the GitTree for `rootPath`, kept fresh by the shared
 *  per-workspace gitStatusStore. */
export function useGitTree(rootPath: string): GitTree | undefined {
  return useGitTreeFor(rootPath)
}
