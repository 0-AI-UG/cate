// =============================================================================
// useFileSync — the single owner of an editor buffer's relationship with its
// file on disk.
//
// One hook, one state machine. Everything about keeping a Monaco buffer in sync
// with disk lives here so EditorPanel can stay a thin Monaco-lifecycle + render
// component:
//
//   • baseline   — the disk content we last synced with (load / save)
//   • dirty      — whether the buffer has unsaved user edits
//   • conflict   — none | changed (external edit vs our unsaved edits)
//                       | deleted (file removed while open)
//
// Inputs of divergence and how they resolve:
//   - user edit            → mark dirty (noteUserEdit)
//   - external change, clean buffer → silent reload + advance baseline
//   - external change, dirty buffer → `changed` conflict
//   - external delete      → `deleted` conflict (+ keep buffer as unsaved work)
//   - save                 → re-read disk and refuse to clobber a divergence
//                            (watcher-independent guard)
//
// Resolutions: reload (take disk), keepMine (my buffer wins), keepBoth (3-way
// merge), saveToRestore (re-create a deleted file), dismiss.
//
// The heavy lifting is delegated to pure, separately-tested helpers:
// classifyExternalEvent, shouldBlockOverwrite, threeWayMerge.
// =============================================================================

import { useCallback, useEffect, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import type * as monaco from 'monaco-editor'
import log from '../logger'
import { useAppStore } from '../../stores/appStore'
import { watchFsRoot } from '../fs/fsWatchManager'
import { isLoadFailed, getBaseline, rememberBaseline } from './modelCache'
import { classifyExternalEvent, shouldBlockOverwrite } from './externalConflict'
import { threeWayMerge } from './threeWayMerge'

// Paths whose model is mid programmatic replace (reload/merge pulled from disk).
// A shared cached model can back several editors, so setValue fires
// onDidChangeModelContent on every one of them — marking the path here for the
// synchronous duration of setValue lets each panel's change listener tell that
// apart from a real user edit. Module-level so it's shared across hook instances
// that point at the same file.
const externalReplacePaths = new Set<string>()

export type EditorConflict = { kind: 'changed'; diskContent?: string } | { kind: 'deleted' } | null

export interface UseFileSyncParams {
  workspaceId: string
  panelId: string
  filePath: string | undefined
  rootPath: string | undefined
  diffMode: 'staged' | 'working' | undefined
  /** Live accessor for the panel's Monaco model (owned by EditorPanel). */
  getModel: () => monaco.editor.ITextModel | null
  /** Called when the hook replaces the buffer from disk (reload / merge), so the
   *  markdown preview can refresh. */
  onExternalReplace?: (content: string) => void
}

export interface FileSync {
  /** Authoritative file path; updated in place after a Save-As. */
  filePathRef: MutableRefObject<string | undefined>
  /** Whether the buffer has unsaved edits. */
  isDirtyRef: MutableRefObject<boolean>
  conflict: EditorConflict
  showDiff: boolean
  openDiff: () => void
  closeDiff: () => void
  /** Record the disk content the buffer was loaded from (the sync baseline). */
  noteLoaded: (content: string) => void
  /** Flag a real user edit (mark dirty + title marker). */
  noteUserEdit: () => void
  /** True while a programmatic disk-driven replace is in flight for this file —
   *  the change listener uses it to ignore the resulting content event. */
  isExternalReplace: () => boolean
  /** Guarded save (Save-As when untitled, overwrite-guard otherwise). */
  save: () => Promise<boolean>
  /** Reconcile a reattached warm model with disk (reopen). Reloads a clean stale
   *  buffer, raises a conflict for unsaved edits, no-ops if disk is unchanged. */
  resyncFromDisk: () => Promise<void>
  reload: () => void
  keepMine: () => void
  keepBoth: () => void
  saveToRestore: () => Promise<void>
  dismiss: () => void
}

export function useFileSync({
  workspaceId,
  panelId,
  filePath,
  rootPath,
  diffMode,
  getModel,
  onExternalReplace,
}: UseFileSyncParams): FileSync {
  const isDirtyRef = useRef(false)
  const filePathRef = useRef(filePath)
  // The disk content we last synced with: set on load and after every save. The
  // save guard and 3-way merge use it; null = no baseline (untitled / unloaded).
  const baselineRef = useRef<string | null>(null)

  // Only overwrite the ref from the prop when the prop is itself defined. In
  // detached/dock windows the shell keeps its own local `panels` state and never
  // emits the global appStore update we issue after a Save-As, so the prop stays
  // undefined for this mount's lifetime — without this guard every re-render
  // would wipe the path we just learned and the next Cmd+S would reopen Save-As.
  if (filePath !== undefined) filePathRef.current = filePath

  const [conflict, setConflict] = useState<EditorConflict>(null)
  const [showDiff, setShowDiff] = useState(false)

  const onExternalReplaceRef = useRef(onExternalReplace)
  onExternalReplaceRef.current = onExternalReplace

  // ---------------------------------------------------------------------------
  // Dirty marker (buffer ↔ panel title/state)
  // ---------------------------------------------------------------------------

  const noteUserEdit = useCallback(() => {
    if (isDirtyRef.current) return
    isDirtyRef.current = true
    useAppStore.getState().setPanelDirty(workspaceId, panelId, true)
    if (filePathRef.current) {
      const fileName = filePathRef.current.split('/').pop() ?? 'Untitled'
      useAppStore.getState().updatePanelTitle(workspaceId, panelId, `${fileName} •`)
    }
  }, [workspaceId, panelId])

  const clearDirty = useCallback(() => {
    isDirtyRef.current = false
    useAppStore.getState().setPanelDirty(workspaceId, panelId, false)
    if (filePathRef.current) {
      const fileName = filePathRef.current.split('/').pop() ?? 'Untitled'
      useAppStore.getState().updatePanelTitle(workspaceId, panelId, fileName)
    }
  }, [workspaceId, panelId])

  // Set the sync baseline (the disk content we last synced with) both locally
  // and in the shared model cache, so a later reopen of this file can recover it
  // and tell unsaved edits apart from a stale-but-clean buffer.
  const setBaseline = useCallback((content: string) => {
    baselineRef.current = content
    const path = filePathRef.current
    if (path) rememberBaseline(path, content)
  }, [])

  const noteLoaded = useCallback((content: string) => {
    setBaseline(content)
  }, [setBaseline])

  const isExternalReplace = useCallback(
    () => !!filePathRef.current && externalReplacePaths.has(filePathRef.current),
    [],
  )

  // Replace the buffer from a disk-derived string without it being mistaken for a
  // user edit. Returns false if there's no live model to write into.
  const replaceBuffer = useCallback((content: string): boolean => {
    const model = getModel()
    if (!model || model.isDisposed()) return false
    const path = filePathRef.current
    if (path) externalReplacePaths.add(path)
    try {
      model.setValue(content)
    } finally {
      if (path) externalReplacePaths.delete(path)
    }
    onExternalReplaceRef.current?.(content)
    return true
  }, [getModel])

  // ---------------------------------------------------------------------------
  // Save (guarded)
  // ---------------------------------------------------------------------------

  const save = useCallback(async (): Promise<boolean> => {
    if (diffMode) return false
    const model = getModel()
    if (!model || model.isDisposed()) return false

    // Never write a buffer that failed to load — its contents are an empty
    // placeholder, and saving would truncate the real file.
    if (filePathRef.current && isLoadFailed(filePathRef.current)) {
      log.warn('[useFileSync] Refusing to save — file never loaded successfully:', filePathRef.current)
      return false
    }

    const content = model.getValue()

    // Untitled buffer: prompt for a destination via the native Save-As dialog.
    let targetPath = filePathRef.current
    let isInitialSave = false
    if (!targetPath) {
      const currentPanel = useAppStore
        .getState()
        .workspaces.find((w) => w.id === workspaceId)?.panels[panelId]
      const cleanTitle = currentPanel?.title?.replace(/\s•\s*$/, '').trim()
      const defaultName = cleanTitle && cleanTitle !== 'Untitled' ? cleanTitle : 'Untitled.txt'
      const sep = rootPath?.includes('\\') ? '\\' : '/'
      const defaultPath = rootPath ? `${rootPath}${sep}${defaultName}` : defaultName
      const chosen = await window.electronAPI.saveFileDialog({ defaultName, defaultPath })
      if (!chosen) return false
      targetPath = chosen
      isInitialSave = true
    }

    // External-change guard (watcher-independent): re-read before overwriting.
    // If the file changed on disk since we last synced AND that version differs
    // from our buffer, surface the conflict instead of clobbering it. Skipped for
    // the initial Save-As (no baseline) and when the read fails (deleted file →
    // fall through so a Save-to-restore re-creates it).
    if (!isInitialSave && baselineRef.current !== null) {
      let diskNow: string | null = null
      try {
        diskNow = await window.electronAPI.fsReadFile(targetPath, workspaceId)
      } catch {
        diskNow = null
      }
      if (shouldBlockOverwrite(baselineRef.current, diskNow, content)) {
        setConflict({ kind: 'changed', diskContent: diskNow ?? undefined })
        return false
      }
    }

    try {
      await window.electronAPI.fsWriteFile(targetPath, content, workspaceId)
    } catch (err) {
      log.error('[useFileSync] Failed to save file:', err)
      return false
    }

    baselineRef.current = content
    rememberBaseline(targetPath, content)
    clearDirty()
    // clearDirty restores the title for an already-known path; for the initial
    // Save-As below we also set the freshly-derived name.
    const fileName = targetPath.split(/[\\/]/).pop() || 'Untitled'
    useAppStore.getState().updatePanelTitle(workspaceId, panelId, fileName)

    if (isInitialSave) {
      filePathRef.current = targetPath
      useAppStore.getState().updatePanelFilePath(workspaceId, panelId, targetPath)
      useAppStore.getState().setPanelUnsavedContent(workspaceId, panelId, undefined)
      window.dispatchEvent(
        new CustomEvent('editor:panel-saved-as', {
          detail: { panelId, filePath: targetPath, title: fileName },
        }),
      )
    }
    return true
  }, [workspaceId, panelId, diffMode, rootPath, getModel, clearDirty])

  // ---------------------------------------------------------------------------
  // Conflict resolutions
  // ---------------------------------------------------------------------------

  // Take the on-disk version, discarding the unsaved buffer edits.
  const reload = useCallback(() => {
    const content = conflict?.kind === 'changed' ? conflict.diskContent ?? '' : ''
    replaceBuffer(content)
    setBaseline(content)
    clearDirty()
    setShowDiff(false)
    setConflict(null)
  }, [conflict, clearDirty, replaceBuffer, setBaseline])

  // Keep the unsaved buffer over the external version. Adopt the on-disk content
  // as the new baseline so the next save writes the buffer straight over it
  // instead of re-flagging the same conflict.
  const keepMine = useCallback(() => {
    if (conflict?.kind === 'changed' && conflict.diskContent !== undefined) {
      setBaseline(conflict.diskContent)
    }
    setShowDiff(false)
    setConflict(null)
  }, [conflict, setBaseline])

  // Merge both sides: baseline = common ancestor, buffer = mine, disk = theirs.
  // Non-overlapping edits combine cleanly; overlapping edits get conflict
  // markers. The result lands in the buffer (dirty) for the user to review and
  // save — nothing is written to disk here.
  const keepBoth = useCallback(() => {
    if (conflict?.kind !== 'changed') return
    const model = getModel()
    if (!model || model.isDisposed()) return
    const theirs = conflict.diskContent ?? ''
    const { merged } = threeWayMerge(baselineRef.current ?? '', model.getValue(), theirs, {
      mine: 'Your changes',
      theirs: 'On disk',
    })
    if (!replaceBuffer(merged)) return
    noteUserEdit()
    // Disk still holds `theirs`; make it the baseline so saving the merged buffer
    // passes the guard (disk === baseline) and writes cleanly.
    setBaseline(theirs)
    setShowDiff(false)
    setConflict(null)
  }, [conflict, getModel, replaceBuffer, noteUserEdit, setBaseline])

  // Re-create a deleted file from the buffer contents.
  const saveToRestore = useCallback(async () => {
    const ok = await save()
    if (ok) {
      setShowDiff(false)
      setConflict(null)
    }
  }, [save])

  // Dismiss without resolving (deleted-conflict Dismiss). The buffer stays dirty
  // so the close-confirm still protects it.
  const dismiss = useCallback(() => {
    setShowDiff(false)
    setConflict(null)
  }, [])

  // ---------------------------------------------------------------------------
  // Reconcile the buffer against disk
  // ---------------------------------------------------------------------------

  // Apply a fresh on-disk version after an external event KNOWN to have changed
  // disk: silently reload a clean buffer, or raise a `changed` conflict when the
  // buffer is dirty so unsaved edits aren't lost.
  const applyDiskContent = useCallback((content: string) => {
    const model = getModel()
    if (!model || model.isDisposed()) return
    // Disk already matches the buffer (e.g. our own save fired the event) —
    // nothing diverges, so clear any stale conflict and skip the reset.
    if (model.getValue() === content) {
      setBaseline(content)
      setConflict(null)
      return
    }
    if (isDirtyRef.current) {
      setConflict({ kind: 'changed', diskContent: content })
      return
    }
    replaceBuffer(content)
    setBaseline(content)
    setConflict(null)
  }, [getModel, replaceBuffer, setBaseline])

  // Reconcile the buffer with disk when a warm cached model is reattached on
  // reopen: while the panel was closed no watcher kept it current, so the buffer
  // may be stale-but-clean or hold unsaved edits. Recover the baseline the model
  // was last synced with (kept in the model cache) to tell those apart safely:
  //   • clean buffer, disk moved → silent reload (the buffer catches up)
  //   • unsaved edits, disk moved → `changed` conflict (never clobber edits)
  //   • disk unchanged            → leave the buffer, just restore the dirty dot
  const resyncFromDisk = useCallback(async () => {
    const path = filePathRef.current
    if (!path || diffMode || path.startsWith('cate-runtime://')) return
    const model = getModel()
    if (!model || model.isDisposed()) return
    const baseline = getBaseline(path)
    if (baseline === undefined) return // unknown baseline → don't risk a reload
    baselineRef.current = baseline
    const buffer = model.getValue()
    const dirty = buffer !== baseline
    // A warm reopen starts a fresh hook (isDirty=false); restore the marker so a
    // genuinely-dirty buffer is treated as such by the reconcile below and the UI.
    if (dirty && !isDirtyRef.current) noteUserEdit()
    let disk: string
    try {
      disk = await window.electronAPI.fsReadFile(path, workspaceId)
    } catch {
      return // gone/unreadable while closed — leave it to the live watcher
    }
    if (disk === baseline) return // nothing changed on disk while we were closed
    if (dirty) {
      setConflict({ kind: 'changed', diskContent: disk })
    } else {
      replaceBuffer(disk)
      setBaseline(disk)
      setConflict(null)
    }
  }, [workspaceId, diffMode, getModel, replaceBuffer, noteUserEdit, setBaseline])

  // ---------------------------------------------------------------------------
  // Watch the file on disk for external edits / deletion
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!filePath || !rootPath || diffMode) return
    // Remote/runtime files live behind a locator the local root watcher can't
    // match; their changes aren't covered here (the save guard still applies).
    if (filePath.startsWith('cate-runtime://')) return

    const targetPosix = filePath.replace(/\\/g, '/')
    let disposed = false

    const stop = watchFsRoot(
      rootPath,
      (event) => {
        if (event.path.replace(/\\/g, '/') !== targetPosix) return

        if (classifyExternalEvent(event.type, isDirtyRef.current) === 'conflict-deleted') {
          // Guard against atomic-write churn (delete + immediate recreate): a
          // real read a tick later tells us whether the file is truly gone.
          window.setTimeout(() => {
            if (disposed) return
            window.electronAPI
              .fsReadFile(filePath, workspaceId)
              .then((content) => { if (!disposed) applyDiskContent(content) })
              .catch(() => {
                if (disposed) return
                // Genuinely deleted: the buffer is now unsaved work with no file
                // behind it. Mark it dirty so the dot shows and close-confirm
                // protects it, and offer to restore.
                noteUserEdit()
                setConflict({ kind: 'deleted' })
              })
          }, 150)
          return
        }

        window.electronAPI
          .fsReadFile(filePath, workspaceId)
          .then((content) => { if (!disposed) applyDiskContent(content) })
          .catch(() => { /* vanished between event and read — leave buffer as-is */ })
      },
      workspaceId,
    )

    return () => {
      disposed = true
      stop()
    }
  }, [filePath, rootPath, workspaceId, diffMode, applyDiskContent, noteUserEdit])

  // Reset conflict state when the panel switches files (a single EditorPanel
  // mount is reused across dock tabs, so stale conflict UI must not carry over).
  useEffect(() => {
    setConflict(null)
    setShowDiff(false)
  }, [filePath])

  const openDiff = useCallback(() => setShowDiff(true), [])
  const closeDiff = useCallback(() => setShowDiff(false), [])

  return {
    filePathRef,
    isDirtyRef,
    conflict,
    showDiff,
    openDiff,
    closeDiff,
    noteLoaded,
    noteUserEdit,
    isExternalReplace,
    save,
    resyncFromDisk,
    reload,
    keepMine,
    keepBoth,
    saveToRestore,
    dismiss,
  }
}
