// The shared "do something with a worktree" layer: create, launch a panel in,
// publish, open or create a PR, update from the base, merge, rename, recolor,
// discard and clean up. The canvas worktree menu and any other
// worktree surface bind their buttons to these.

import { useCallback } from 'react'
import { isRpcError } from '@kernel/rpc/contract'
import { useRuntime } from '../../kernel/rpc'
import { clientUi, errorMessage } from '@kernel/interaction'
import type { WorktreeMeta } from '@workspace/document/contract'
// Brings the `file` capability into the runtime proxy's type.

import { pickWorktreeColor, samePath, toBranchName, type JoinedWorktree, type PrSummary } from '@workspace/repository/contract'
import { useRepositoryUi } from './context'
import type { ContextMenuItem } from '@kernel/interaction/contract'

/** The per-worktree action set a row binds its buttons and menu to. */
export interface CardCallbacks {
  onLaunch: (type: string) => void
  onPublish: () => void
  onCreatePR: () => void
  onUpdateFromMain: () => void
  onMerge: () => void
  onDelete: () => void
  onRename: (label: string | undefined) => void
  onRecolor: (color: string) => void
  onOpenPr: (url?: string) => void
  onError: (message: string) => void
}

/** Opens the "more actions" menu of a worktree row. Rename and recolor are
 *  local to the row, so the caller says how to begin them. */
export async function runWorktreeContextMenu(opts: {
  isPrimary: boolean
  hasPr: boolean
  prUrl?: string
  primaryLabel: string
  cb: CardCallbacks
  beginRename?: () => void
  beginRecolor?: () => void
}): Promise<void> {
  const items: ContextMenuItem[] = [
    { id: 'publish', label: 'Publish branch' },
    { id: 'pr', label: opts.hasPr ? 'Open pull request' : 'Create pull request' },
  ]
  if (!opts.isPrimary && opts.primaryLabel) {
    items.push({ id: 'update', label: `Update from ${opts.primaryLabel}` })
    items.push({ id: 'merge', label: `Merge into ${opts.primaryLabel}` })
  }
  items.push({ type: 'separator' })
  if (opts.beginRename) items.push({ id: 'rename', label: 'Rename…' })
  if (opts.beginRecolor) items.push({ id: 'color', label: 'Change color…' })
  if (!opts.isPrimary) {
    items.push({ type: 'separator' })
    items.push({ id: 'delete', label: 'Discard this work…' })
  }
  let choice: string | null
  try {
    const ui = clientUi()
    if (!ui.showContextMenu) throw new Error('The menu is unavailable.')
    choice = await ui.showContextMenu(items)
  } catch (err: unknown) {
    opts.cb.onError(`Couldn’t open worktree actions: ${errorMessage(err, 'The menu is unavailable.')}`)
    return
  }
  switch (choice) {
    case 'publish': opts.cb.onPublish(); break
    case 'pr': if (opts.hasPr) opts.cb.onOpenPr(opts.prUrl); else opts.cb.onCreatePR(); break
    case 'update': opts.cb.onUpdateFromMain(); break
    case 'merge': opts.cb.onMerge(); break
    case 'rename': opts.beginRename?.(); break
    case 'color': opts.beginRecolor?.(); break
    case 'delete': opts.cb.onDelete(); break
  }
}

export interface ParallelWork {
  createWorktree: (rawName: string, baseRef?: string) => Promise<WorktreeMeta | null>
  checkoutPr: (pr: PrSummary) => Promise<WorktreeMeta | null>
  /** Opens a terminal or chat bound to a worktree; `canvasPanelId` pins it to
   *  that canvas. */
  launchInWorktree: (wt: JoinedWorktree, type: string, canvasPanelId?: string) => Promise<boolean>
  handlePublish: (wt: JoinedWorktree) => Promise<void>
  handleCreatePR: (wt: JoinedWorktree) => Promise<void>
  handleUpdateFromMain: (wt: JoinedWorktree) => Promise<void>
  handleMerge: (wt: JoinedWorktree) => Promise<void>
  handleDelete: (wt: JoinedWorktree) => Promise<void>
  /** Drops metadata whose checkout is gone (asks about their panels first). */
  handlePrune: (orphans: JoinedWorktree[]) => Promise<void>
  /** Drops one orphan's metadata and bound panels. */
  removeOrphan: (worktreeId: string) => Promise<void>
  makeCallbacks: (wt: JoinedWorktree) => CardCallbacks
}

const isMissing = (err: unknown) =>
  isRpcError(err, 'gone') || /\bENOENT\b|no such file or directory/i.test(String(err))

export function useParallelWork(
  primaryLabel: string,
  opts: {
    setError: (v: string | null) => void
    onPrCreated?: () => void
    /** A worktree id while a slow op runs on it, then null. */
    setBusy?: (id: string | null) => void
  },
): ParallelWork {
  const host = useRepositoryUi()
  const runtime = useRuntime(host.workspaceId)
  const { setError, onPrCreated, setBusy } = opts
  const { root } = host

  const createWorktree = useCallback(async (rawName: string, baseRef?: string) => {
    if (!runtime) return null
    const branch = toBranchName(rawName)
    if (!branch) throw new Error('Please enter a name')
    const label = rawName.trim() !== branch ? rawName.trim() : undefined
    return runtime.vcs.worktreeCreate({ branch, ...(baseRef ? { base: baseRef } : {}), ...(label ? { label } : {}) })
  }, [runtime])

  const checkoutPr = useCallback(async (pr: PrSummary) => {
    if (!runtime) return null
    return runtime.vcs.worktreeCreate({ branch: pr.headRefName, fromPr: pr.number, label: `#${pr.number} ${pr.headRefName}` })
  }, [runtime])

  const launchInWorktree = useCallback(
    (wt: JoinedWorktree, type: string, canvasPanelId?: string) =>
      host.launchInWorktree(wt, type, canvasPanelId ? { canvasPanelId } : undefined),
    [host],
  )

  const handlePublish = useCallback(async (wt: JoinedWorktree) => {
    if (!wt.branch || !runtime) return
    setError(null)
    setBusy?.(wt.id)
    try {
      await runtime.vcs.push({ cwd: wt.path, remote: 'origin', branch: wt.branch })
    } catch (err: unknown) {
      setError(`Publish failed: ${errorMessage(err, 'Couldn’t publish this branch.')}`)
    } finally {
      setBusy?.(null)
    }
  }, [runtime, setBusy, setError])

  const handleCreatePR = useCallback(async (wt: JoinedWorktree) => {
    if (!wt.branch || !runtime) return
    if (wt.prNumber) {
      setError(`This worktree already belongs to PR #${wt.prNumber}. Open that pull request instead.`)
      return
    }
    setError(null)
    setBusy?.(wt.id)
    try {
      const res = await runtime.vcs.createPr({ path: wt.path, branch: wt.branch })
      if (res.ok) {
        clientUi().openExternal(res.url)
        onPrCreated?.()
      } else {
        setError(errorMessage(res.message, 'Couldn’t create the pull request.'))
      }
    } catch (err: unknown) {
      setError(`Couldn’t create pull request: ${errorMessage(err, 'The operation failed.')}`)
    } finally {
      setBusy?.(null)
    }
  }, [runtime, onPrCreated, setBusy, setError])

  const handleUpdateFromMain = useCallback(async (wt: JoinedWorktree) => {
    if (wt.isPrimary || !wt.branch || !runtime) return
    const target = primaryLabel
    if (!target) {
      setError('Could not resolve the base branch. Open Source Control once to refresh.')
      return
    }
    setBusy?.(wt.id)
    try {
      const result = await runtime.vcs.worktreeUpdateFrom({ path: wt.path, from: target })
      if (!result.ok) {
        setError(result.conflict
          ? `Conflicts updating from ${target} — open a terminal here to resolve them.`
          : `Update from ${target}: ${errorMessage(result.message, 'The update failed.')}`)
      } else {
        setError(null)
      }
    } catch (err: unknown) {
      setError(`Update failed: ${errorMessage(err, 'The operation failed.')}`)
    } finally {
      setBusy?.(null)
    }
  }, [runtime, primaryLabel, setBusy, setError])

  const handleMerge = useCallback(async (wt: JoinedWorktree) => {
    if (!root || wt.isPrimary || !runtime) return
    const target = primaryLabel
    if (!wt.branch || !target) {
      setError('Could not resolve the base branch — open Source Control once to refresh.')
      return
    }
    if (!(await clientUi().confirm(`Merge ${wt.branch} into ${target}?`))) return
    setBusy?.(wt.id)
    try {
      const result = await runtime.vcs.worktreeMergeTo({ cwd: root, from: wt.branch, to: target })
      if (!result.ok) setError(`Merge ${wt.branch} → ${target}: ${errorMessage(result.message, 'The merge failed.')}`)
      else setError(null)
    } catch (err: unknown) {
      setError(`Merge failed: ${errorMessage(err, 'The operation failed.')}`)
    } finally {
      setBusy?.(null)
    }
  }, [runtime, root, primaryLabel, setBusy, setError])

  const handleDelete = useCallback(async (wt: JoinedWorktree) => {
    if (!root || !runtime || wt.isPrimary) return
    const label = wt.label || wt.branch || wt.path
    // Fresh status so the warnings and the force flag are right whichever
    // surface asked.
    let status: Awaited<ReturnType<typeof runtime.vcs.worktreeStatus>> = null
    try {
      status = await runtime.vcs.worktreeStatus({ path: wt.path })
    } catch (err: unknown) {
      setError(`Couldn’t verify this worktree before discarding it: ${errorMessage(err, 'Status is unavailable.')}`)
      return
    }
    let missing = false
    if (!status) {
      try {
        await runtime.file.stat({ path: wt.path })
      } catch (err: unknown) {
        missing = isMissing(err)
      }
      if (!missing) {
        setError('Couldn’t verify this worktree before discarding it. No files were removed.')
        return
      }
    }
    const dirty = !!status?.dirty
    const branchAhead = (status?.ahead ?? 0) > 0
    const panels = host.worktreePanelSummary(wt.id)
    const ok = await clientUi().confirm(
      `Discard “${label}”?\n\n` +
        `This deletes the parallel branch and everything in it.\n` +
        (panels.count ? `\nIts ${panels.count} open ${panels.count === 1 ? 'panel' : 'panels'} will be closed.` : '') +
        (dirty ? '\nWARNING: uncommitted changes here will be lost.' : '') +
        (panels.hasDirtyEditor ? '\nWARNING: an editor has unsaved changes.' : '') +
        (branchAhead ? `\nWARNING: ${status?.ahead} unpublished commit(s) will be lost.` : '') +
        (missing ? '\nThe worktree folder is missing. Its Git record and branch will be removed.' : ''),
    )
    if (!ok) return
    if (!(await host.prepareWorktreeClose(wt.id))) return
    // Saving an editor while asking may have dirtied the checkout since the
    // first check; re-read before choosing git's force flag.
    let removalDirty = dirty
    if (!missing) {
      try {
        removalDirty = !!(await runtime.vcs.worktreeStatus({ path: wt.path }))?.dirty
      } catch (err: unknown) {
        setError(`Couldn’t re-verify this worktree before discarding it: ${errorMessage(err, 'Status is unavailable.')}`)
        return
      }
    }
    setBusy?.(wt.id)
    try {
      const result = await runtime.vcs.worktreeRemove({
        worktreeId: wt.id,
        force: dirty || removalDirty || panels.hasDirtyEditor,
      })
      if (result.branchDeleteError && wt.branch) {
        setError(`Removed, but branch ${wt.branch} could not be deleted: ${result.branchDeleteError}`)
      }
    } catch (err: unknown) {
      setError(`Discard failed: ${errorMessage(err, 'The worktree was not removed.')}`)
    } finally {
      setBusy?.(null)
    }
  }, [host, runtime, root, setBusy, setError])

  const handlePrune = useCallback(async (orphans: JoinedWorktree[]) => {
    if (!runtime) return
    try {
      // Prune drops every orphan with its bound panels, so ask about all of
      // them first; one refusal keeps them all.
      for (const orphan of orphans) {
        if (!(await host.prepareWorktreeClose(orphan.id))) return
      }
      await runtime.vcs.worktreePrune()
    } catch (err: unknown) {
      setError(`Cleanup failed: ${errorMessage(err, 'No saved entries were removed.')}`)
    }
  }, [host, runtime, setError])

  const removeOrphan = useCallback(async (worktreeId: string) => {
    if (!runtime) return
    if (!(await host.prepareWorktreeClose(worktreeId))) return
    try {
      await runtime.vcs.worktreeRemove({ worktreeId, force: true })
    } catch (err: unknown) {
      setError(`Couldn’t remove this entry: ${errorMessage(err, 'The operation failed.')}`)
    }
  }, [host, runtime, setError])

  const updateMeta = useCallback((wt: JoinedWorktree, patch: { color?: string; label?: string }) => {
    // A checkout git lists but the document has no metadata for yet gets it now.
    const existing = host.worktrees.find((w) => w.id === wt.id || samePath(w.path, wt.path))
    const base: WorktreeMeta = existing ?? {
      id: `wt-${crypto.randomUUID()}`,
      path: wt.path,
      color: wt.color ?? pickWorktreeColor(host.worktrees),
      status: 'ready',
    }
    const next: WorktreeMeta = { ...base, ...('color' in patch ? { color: patch.color! } : {}) }
    if ('label' in patch) {
      if (patch.label) next.label = patch.label
      else delete next.label
    }
    host.setWorktree(next)
  }, [host])

  const makeCallbacks = useCallback((wt: JoinedWorktree): CardCallbacks => {
    const ui = clientUi()
    return {
      onLaunch: (type) => { void launchInWorktree(wt, type) },
      onPublish: () => void handlePublish(wt),
      onCreatePR: () => void handleCreatePR(wt),
      onUpdateFromMain: () => void handleUpdateFromMain(wt),
      onMerge: () => void handleMerge(wt),
      onDelete: () => void handleDelete(wt),
      onRename: (label) => updateMeta(wt, { label: label?.trim() || undefined }),
      onRecolor: (color) => updateMeta(wt, { color }),
      onOpenPr: (url) => {
        if (url) ui.openExternal(url)
        else {
          const prLabel = wt.prNumber ? `PR #${wt.prNumber}` : 'the pull request'
          setError(`Couldn’t load ${prLabel}. Check your GitHub connection and try again.`)
        }
      },
      onError: setError,
    }
  }, [launchInWorktree, handlePublish, handleCreatePR, handleUpdateFromMain, handleMerge, handleDelete, updateMeta, setError])

  return {
    createWorktree,
    checkoutPr,
    launchInWorktree,
    handlePublish,
    handleCreatePR,
    handleUpdateFromMain,
    handleMerge,
    handleDelete,
    handlePrune,
    removeOrphan,
    makeCallbacks,
  }
}
