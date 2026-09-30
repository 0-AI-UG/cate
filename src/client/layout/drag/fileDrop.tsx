// HTML5 file drags: files from the file tree or search (workspace paths) and
// from the OS (the `fileDrop` feature). One window-level tracker finds the
// nearest `[data-filedrop]` host under the cursor and one overlay marks it;
// drop handling stays in the hosts. OS files reach the runtime through the
// `file.importEntries` stream (workspace/files), so a drop works the same on
// a local and a remote workspace.

import React, { useCallback, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { create } from 'zustand'
import type { PanelPlacementOptions } from '@panels/framework/contract'
import { clientHas } from '@client/connections'
import { fsClient } from '@workspace/files/client'
import {
  CATE_FILE_MIME,
  CATE_FILES_MIME,
  isExternalFileDrag,
  readCateFileLocation,
  readCateFilePaths,
  readDroppedEntries,
  takeDroppedItems,
  type FileLineLocation,
} from '@workspace/files/ui'

export type FileDropKind = 'canvas' | 'dock' | 'terminal' | 'agent'

// --- Opening dropped files ------------------------------------------------------

export interface FileDropHandler {
  /** Opens workspace files where they were dropped (the editor's module
   *  installs this). `location` reveals a line in the file it names. */
  openFiles(workspaceId: string, paths: string[], placement: PanelPlacementOptions, location?: FileLineLocation | null): void
  /** The folder OS files are imported into before they open; null skips. */
  importDestination?(workspaceId: string): Promise<string | null>
  /** An import started; `done` settles when `file.importEntries` finished
   *  (the shell blocks quitting until then). */
  importing?(workspaceId: string, done: Promise<unknown>): void
}

let handler: FileDropHandler | null = null

export function installFileDropHandler(next: FileDropHandler | null): void {
  handler = next
}

/** Workspace paths an in-app file drag carries. */
export function droppedPaths(dataTransfer: Pick<DataTransfer, 'getData'>): string[] {
  return readCateFilePaths(dataTransfer)
}

/** Imports OS files into the workspace and resolves with their new paths. */
export async function importDroppedFiles(workspaceId: string, dataTransfer: DataTransfer): Promise<string[]> {
  if (!clientHas('fileDrop') || !handler?.importDestination) return []
  // Items must be taken inside the drop handler; contents are read later.
  const items = takeDroppedItems(dataTransfer)
  const destination = await handler.importDestination(workspaceId)
  const fs = fsClient(workspaceId)
  if (!destination || !fs || items.length === 0) return []
  const run = (async () => {
    const sources = await readDroppedEntries(items)
    return (await fs.importEntries(destination, sources)).created
  })()
  handler.importing?.(workspaceId, run)
  return run
}

/** Drop handling for a dock: opens the dropped files as tabs there. */
export function useDockFileDrop(workspaceId: string, placement: () => PanelPlacementOptions) {
  const onDragOver = useCallback((e: React.DragEvent<HTMLElement>) => {
    if (e.dataTransfer.types.includes(CATE_FILE_MIME) || e.dataTransfer.types.includes(CATE_FILES_MIME) || e.dataTransfer.types.includes('Files')) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  }, [])
  const onDrop = useCallback((e: React.DragEvent<HTMLElement>) => {
    if (!handler) return
    const paths = droppedPaths(e.dataTransfer)
    const location = readCateFileLocation(e.dataTransfer)
    const external = paths.length === 0 && isExternalFileDrag(e)
    if (paths.length === 0 && !external) return
    e.preventDefault()
    e.stopPropagation()
    const at = placement()
    if (!external) {
      handler.openFiles(workspaceId, paths, at, location)
      return
    }
    void importDroppedFiles(workspaceId, e.dataTransfer).then((created) => {
      if (created.length > 0) handler?.openFiles(workspaceId, created, at, null)
    })
  }, [workspaceId, placement])
  return { onDragOver, onDrop }
}

// --- The indicator ----------------------------------------------------------------

interface FileDropTarget {
  kind: FileDropKind
  id: string
  host: HTMLElement
}

interface FileDropState {
  target: FileDropTarget | null
  active: boolean
  set: (target: FileDropTarget | null) => void
  setActive: (active: boolean) => void
}

const useFileDropStore = create<FileDropState>((set) => ({
  target: null,
  active: false,
  set: (target) => set({ target }),
  setActive: (active) => set({ active }),
}))

export function useFileDragActive(): boolean {
  return useFileDropStore((state) => state.active)
}

export function isFileDrag(e: DragEvent): boolean {
  const types = e.dataTransfer?.types
  if (!types) return false
  return types.includes(CATE_FILE_MIME) || types.includes(CATE_FILES_MIME) || types.includes('Files')
}

/** Tracks the file-drop host under the cursor. Once per window. */
export function useFileDropTracker(): void {
  useEffect(() => {
    const onDragOver = (e: DragEvent): void => {
      if (!isFileDrag(e)) return
      useFileDropStore.getState().setActive(true)
      e.preventDefault()
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null
      const host = el?.closest('[data-filedrop]') as HTMLElement | null
      const store = useFileDropStore.getState()
      if (!host) {
        if (store.target) store.set(null)
        return
      }
      if (store.target?.host === host) return
      store.set({ kind: host.getAttribute('data-filedrop') as FileDropKind, id: host.getAttribute('data-filedrop-id') ?? '', host })
    }
    const clear = (): void => {
      const store = useFileDropStore.getState()
      if (store.target) store.set(null)
      store.setActive(false)
    }
    // No related target: the cursor left the window.
    const onDragLeave = (e: DragEvent): void => { if (!e.relatedTarget) clear() }
    // Capture, ahead of hosts that stop propagation (the terminal does).
    window.addEventListener('dragover', onDragOver, true)
    window.addEventListener('drop', clear, true)
    window.addEventListener('dragend', clear, true)
    window.addEventListener('dragleave', onDragLeave, true)
    return () => {
      window.removeEventListener('dragover', onDragOver, true)
      window.removeEventListener('drop', clear, true)
      window.removeEventListener('dragend', clear, true)
      window.removeEventListener('dragleave', onDragLeave, true)
    }
  }, [])
}

const LABEL: Record<FileDropKind, string> = {
  canvas: 'Drop to open on canvas',
  dock: 'Drop to open here',
  terminal: 'Drop to paste path',
  agent: 'Drop to attach',
}

/** The one indicator, drawn inside its host so it inherits the host's
 *  clipping, transform and stacking. */
export const FileDropOverlay: React.FC = () => {
  const target = useFileDropStore((s) => s.target)
  if (!target) return null
  return createPortal(
    <div
      data-file-drop-indicator={target.kind}
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 60,
        boxSizing: 'border-box',
        border: '2px dashed rgba(74, 158, 255, 0.7)',
        background: 'rgba(74, 158, 255, 0.12)',
        borderRadius: 6,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <span
        style={{
          fontSize: 12,
          fontWeight: 500,
          color: '#fff',
          background: 'rgba(34, 92, 158, 0.92)',
          padding: '4px 10px',
          borderRadius: 6,
          boxShadow: '0 2px 8px rgba(0,0,0,0.35)',
        }}
      >
        {LABEL[target.kind]}
      </span>
    </div>,
    target.host,
  )
}
