// =============================================================================
// useGitTree — load the repo's git decorations (the same GitTree the Explorer
// builds) for any view that wants to tint paths by git status. Used by the
// Search view so result file rows decorate consistently with the file tree.
// =============================================================================

import { useEffect, useState } from 'react'
import { buildGitTreeDecorations, toPosixPath, type GitTree } from './gitStatusDecoration'

/** Build a GitTree for `rootPath` from the git IPC, or undefined outside a repo.
 *  Mirrors FileExplorer.loadTree's git fetch: the porcelain status drives the
 *  per-file decorations while the tracked-file set distinguishes a brand-new
 *  (untracked) file from a git-ignored one. */
export async function loadGitTree(rootPath: string): Promise<GitTree | undefined> {
  const api = window.electronAPI
  if (!api || !rootPath) return undefined
  if (!(await api.gitIsRepo(rootPath))) return undefined
  const [trackedFiles, status] = await Promise.all([
    api.gitLsFiles(rootPath),
    api.gitStatus(rootPath),
  ])
  // gitLsFiles/gitStatus return repo-cwd-relative paths; convert to absolute
  // (posix) so lookups match the absolute paths search results carry.
  const root = toPosixPath(rootPath)
  return {
    tracked: new Set(trackedFiles.map((p) => `${root}/${p}`)),
    decorations: buildGitTreeDecorations(status.files, rootPath),
  }
}

/** React hook returning the GitTree for `rootPath`, kept reasonably fresh:
 *  reloaded on root change, on window focus, and on filesystem-watch events
 *  (when the Explorer's watcher is running). We deliberately don't start our
 *  own fs watcher — that would clobber the Explorer's fsWatchStop bookkeeping. */
export function useGitTree(rootPath: string): GitTree | undefined {
  const [gitTree, setGitTree] = useState<GitTree | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const reload = (): void => {
      loadGitTree(rootPath)
        .then((t) => { if (!cancelled) setGitTree(t) })
        .catch(() => { if (!cancelled) setGitTree(undefined) })
    }
    // Coalesce bursts (e.g. a build writing many files) with a short debounce.
    const scheduleReload = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(reload, 200)
    }

    reload()
    window.addEventListener('focus', scheduleReload)
    const unsubscribe = window.electronAPI?.onFsWatchEvent(scheduleReload)

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      window.removeEventListener('focus', scheduleReload)
      unsubscribe?.()
    }
  }, [rootPath])

  return gitTree
}
