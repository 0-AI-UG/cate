// =============================================================================
// useParallelWork — the shared "do something with a worktree" layer.
//
// All the verbs a worktree card / row offers (launch a terminal or Cate agent,
// publish, open/create a PR, update from main, merge, rename, recolor, reveal,
// discard, clean up orphans) live here so the sidebar's ParallelWorkTab and the
// canvas toolbar's worktree drop-up share one implementation and one error /
// notice channel. Live list + per-worktree status display stay with the
// sidebar; this hook is purely the action surface.
// =============================================================================

import { useCallback } from 'react'
import { useAppStore } from './appStore'
import { useSettingsStore } from './settingsStore'
import type { PanelPlacement } from './appStore'
import { gitStatusStore } from './gitStatusStore'
import { useWorktreeActions } from './useWorktreeActions'
import type { JoinedWorktree } from './useWorktrees'
import type { PrListItem } from '../sidebar/CreateWorktreeForm'
import type { NativeContextMenuItem } from '../../shared/electron-api'

export interface WorktreeStatus {
  branch: string
  dirty: boolean
  ahead: number
  behind: number
  staged: number
  unstaged: number
  untracked: number
}

/** The per-worktree action set a card / row binds its buttons + menu to. */
export interface CardCallbacks {
  onLaunch: (type: 'terminal' | 'agent') => void
  onPublish: () => void
  onCreatePR: () => void
  onUpdateFromMain: () => void
  onMerge: () => void
  onDelete: () => void
  onReveal: () => void
  onRename: (label: string | undefined) => void
  onRecolor: (color: string) => void
  onOpenPr: (url: string) => void
}

/** Build + run the native "more actions" menu shared by the sidebar card and the
 *  toolbar row. Rename / recolor are UI-local, so the caller supplies how to
 *  begin them. */
export async function runWorktreeContextMenu(opts: {
  isPrimary: boolean
  hasPr: boolean
  prUrl?: string
  primaryLabel: string
  cb: CardCallbacks
  beginRename: () => void
  beginRecolor: () => void
}): Promise<void> {
  const items: NativeContextMenuItem[] = [
    { id: 'publish', label: 'Publish branch' },
    { id: 'pr', label: opts.hasPr ? 'Open pull request' : 'Create pull request' },
  ]
  if (!opts.isPrimary) {
    items.push({ id: 'update', label: `Update from ${opts.primaryLabel}` })
    items.push({ id: 'merge', label: `Merge into ${opts.primaryLabel}` })
  }
  items.push({ type: 'separator' })
  items.push({ id: 'rename', label: 'Rename…' })
  items.push({ id: 'color', label: 'Change color…' })
  items.push({ id: 'reveal', label: 'Reveal in Finder' })
  if (!opts.isPrimary) {
    items.push({ type: 'separator' })
    items.push({ id: 'delete', label: 'Discard this work…' })
  }
  const choice = await window.electronAPI.showContextMenu(items)
  switch (choice) {
    case 'publish': opts.cb.onPublish(); break
    case 'pr': if (opts.hasPr && opts.prUrl) opts.cb.onOpenPr(opts.prUrl); else opts.cb.onCreatePR(); break
    case 'update': opts.cb.onUpdateFromMain(); break
    case 'merge': opts.cb.onMerge(); break
    case 'reveal': opts.cb.onReveal(); break
    case 'rename': opts.beginRename(); break
    case 'color': opts.beginRecolor(); break
    case 'delete': opts.cb.onDelete(); break
  }
}

export interface UseParallelWork {
  reconcile: () => void
  createWorktree: (rawName: string, baseRef?: string) => Promise<void>
  checkoutPr: (pr: PrListItem) => Promise<void>
  /** Spawn a terminal or Cate agent bound to a worktree. Pass `placement` to pin
   *  it to a specific canvas (the toolbar does); omit for default placement. */
  launchInWorktree: (wt: JoinedWorktree, type: 'terminal' | 'agent', placement?: PanelPlacement) => void
  handlePublish: (wt: JoinedWorktree) => Promise<void>
  handleCreatePR: (wt: JoinedWorktree) => Promise<void>
  handleUpdateFromMain: (wt: JoinedWorktree) => Promise<void>
  handleMerge: (wt: JoinedWorktree) => Promise<void>
  handleDelete: (wt: JoinedWorktree) => Promise<void>
  handlePrune: () => Promise<void>
  makeCallbacks: (wt: JoinedWorktree) => CardCallbacks
}

export function useParallelWork(
  rootPath: string,
  workspaceId: string | null,
  primaryLabel: string,
  opts: {
    setError: (v: string | null) => void
    setNotice: (v: string | null) => void
    onPrCreated?: () => void
  },
): UseParallelWork {
  const { createWorktree, checkoutPr } = useWorktreeActions(rootPath, workspaceId)
  const removeWorktree = useAppStore((s) => s.removeWorktree)
  const { setError, setNotice, onPrCreated } = opts

  const reconcile = useCallback(() => {
    if (rootPath) gitStatusStore.refresh(rootPath)
  }, [rootPath])

  const launchInWorktree = useCallback(
    (wt: JoinedWorktree, type: 'terminal' | 'agent', placement?: PanelPlacement) => {
      if (!workspaceId) return
      const s = useAppStore.getState()
      const panelId =
        type === 'terminal'
          ? s.createTerminal(workspaceId, undefined, undefined, placement, wt.path)
          : s.createAgent(workspaceId, undefined, placement)
      if (panelId) s.setPanelWorktreeId(workspaceId, panelId, wt.id)
    },
    [workspaceId],
  )

  const handlePublish = useCallback(
    async (wt: JoinedWorktree) => {
      if (!wt.branch) return
      setError(null)
      setNotice(`Publishing ${wt.branch}…`)
      try {
        await window.electronAPI.gitPush(wt.path, 'origin', wt.branch)
        setNotice(`Published ${wt.branch}`)
        reconcile()
      } catch (err: any) {
        setNotice(null)
        setError(`Publish failed: ${err?.message || err}`)
      }
    },
    [reconcile],
  )

  const handleCreatePR = useCallback(
    async (wt: JoinedWorktree) => {
      if (!wt.branch) return
      setError(null)
      setNotice(`Opening a pull request for ${wt.branch}…`)
      try {
        const res = await window.electronAPI.gitCreatePR(wt.path, wt.branch)
        if (res.ok) {
          window.electronAPI.openExternalUrl(res.url)
          setNotice(
            res.created
              ? `Opened a pull request for ${wt.branch}`
              : res.fallback
                ? 'Opened GitHub to finish the pull request'
                : `Pull request for ${wt.branch} already exists`,
          )
          onPrCreated?.()
        } else {
          setNotice(null)
          setError(res.message)
        }
      } catch (err: any) {
        setNotice(null)
        setError(`Could not create pull request: ${err?.message || err}`)
      }
    },
    [onPrCreated],
  )

  const handleUpdateFromMain = useCallback(
    async (wt: JoinedWorktree) => {
      if (wt.isPrimary || !wt.branch) return
      const target = primaryLabel
      try {
        const result = await window.electronAPI.gitWorktreeUpdateFrom(wt.path, target)
        if (!result.ok) {
          setError(
            result.conflict
              ? `Conflicts updating from ${target} — open a terminal here to resolve them.`
              : `Update from ${target}: ${result.message}`,
          )
        } else {
          setError(null)
          setNotice(`Updated ${wt.branch} from ${target}`)
          reconcile()
        }
      } catch (err: any) {
        setError(err?.message || 'Update failed')
      }
    },
    [primaryLabel, reconcile],
  )

  const handleMerge = useCallback(
    async (wt: JoinedWorktree) => {
      if (!rootPath || wt.isPrimary) return
      const target = primaryLabel
      if (!wt.branch || !target) {
        setError('Could not resolve the base branch — open Source Control once to refresh.')
        return
      }
      const ok = window.confirm(`Merge ${wt.branch} into ${target}?`)
      if (!ok) return
      try {
        const result = await window.electronAPI.gitWorktreeMergeTo(rootPath, wt.branch, target)
        if (!result.ok) {
          setError(`Merge ${wt.branch} → ${target}: ${result.message}`)
        } else {
          setError(null)
          setNotice(`Merged ${wt.branch} into ${target}`)
          reconcile()
        }
      } catch (err: any) {
        setError(err?.message || 'Merge failed')
      }
    },
    [rootPath, primaryLabel, reconcile],
  )

  const handleDelete = useCallback(
    async (wt: JoinedWorktree) => {
      if (!rootPath || !workspaceId || wt.isPrimary) return
      const label = wt.label || wt.branch || wt.path
      // Fetch fresh status so the warnings + force flag are right regardless of
      // which surface triggered the discard.
      let status: WorktreeStatus | null = null
      try {
        status = await window.electronAPI.gitWorktreeStatus(wt.path)
      } catch {
        status = null
      }
      const dirty = !!status?.dirty
      const branchAhead = (status?.ahead ?? 0) > 0
      // When the close-on-delete setting is on, count the terminal/agent panels
      // bound to this worktree so the prompt warns about what it'll tear down.
      const ws = useAppStore.getState().workspaces.find((w) => w.id === workspaceId)
      const panelCount = useSettingsStore.getState().closeWorktreePanelsOnDelete
        ? Object.values(ws?.panels ?? {}).filter(
            (p) => p.worktreeId === wt.id && (p.type === 'terminal' || p.type === 'agent'),
          ).length
        : 0
      const ok = window.confirm(
        `Discard “${label}”?\n\n` +
          `This deletes the parallel branch and everything in it.\n` +
          (panelCount
            ? `\nIts ${panelCount} open ${panelCount === 1 ? 'terminal/agent panel' : 'terminal/agent panels'} will be closed.`
            : '') +
          (dirty ? '\nWARNING: unsaved changes here will be lost.' : '') +
          (branchAhead ? `\nWARNING: ${status?.ahead} unpublished commit(s) will be lost.` : ''),
      )
      if (!ok) return
      try {
        await window.electronAPI.gitWorktreeRemove(rootPath, wt.path, { force: dirty })
        if (wt.branch) {
          try {
            await window.electronAPI.gitBranchDelete(rootPath, wt.branch, true)
          } catch (err: any) {
            setError(`Removed, but branch ${wt.branch} could not be deleted: ${err?.message || err}`)
          }
        }
        removeWorktree(workspaceId, wt.id)
        reconcile()
      } catch (err: any) {
        setError(err?.message || 'Discard failed')
      }
    },
    [rootPath, workspaceId, removeWorktree, reconcile],
  )

  const handlePrune = useCallback(async () => {
    if (!rootPath || !workspaceId) return
    try {
      await window.electronAPI.gitWorktreePrune(rootPath)
      // `git worktree prune` only cleans entries git still tracks. The orphans
      // shown here are store metadata for worktrees git no longer lists, so
      // prune is a no-op for them — drop those stale entries from the store
      // explicitly, otherwise "Clean up" appears to do nothing.
      const list = await window.electronAPI.gitWorktreeList(rootPath)
      const livePaths = new Set(list.map((g) => g.path))
      const ws = useAppStore.getState().workspaces.find((w) => w.id === workspaceId)
      for (const w of ws?.worktrees ?? []) {
        if (w.path !== rootPath && !livePaths.has(w.path)) removeWorktree(workspaceId, w.id)
      }
      reconcile()
    } catch (err: any) {
      setError(err?.message || 'Cleanup failed')
    }
  }, [rootPath, workspaceId, removeWorktree, reconcile])

  const makeCallbacks = useCallback(
    (wt: JoinedWorktree): CardCallbacks => ({
      onLaunch: (type) => launchInWorktree(wt, type),
      onPublish: () => handlePublish(wt),
      onCreatePR: () => handleCreatePR(wt),
      onUpdateFromMain: () => handleUpdateFromMain(wt),
      onMerge: () => handleMerge(wt),
      onDelete: () => handleDelete(wt),
      onReveal: () => window.electronAPI.shellShowInFolder(wt.path),
      onRename: (label) => workspaceId && useAppStore.getState().setWorktreeLabel(workspaceId, wt.id, label),
      onRecolor: (color) => workspaceId && useAppStore.getState().setWorktreeColor(workspaceId, wt.id, color),
      onOpenPr: (url) => window.electronAPI.openExternalUrl(url),
    }),
    [launchInWorktree, handlePublish, handleCreatePR, handleUpdateFromMain, handleMerge, handleDelete, workspaceId],
  )

  return {
    reconcile,
    createWorktree,
    checkoutPr,
    launchInWorktree,
    handlePublish,
    handleCreatePR,
    handleUpdateFromMain,
    handleMerge,
    handleDelete,
    handlePrune,
    makeCallbacks,
  }
}
