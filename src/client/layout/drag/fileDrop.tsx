// HTML5 file drags: file refs from the file tree, search and screenshots,
// and files from the OS (the `fileDrop` feature). One window-level tracker
// finds the nearest `[data-filedrop]` host under the cursor and one overlay
// marks it; drop handling stays in the hosts, which all resolve a drop the
// same way (`dropFilesInto`): a workspace's own files as they are, anything
// else copied into its checkout's `.cate/tmp` through the runtimes.

import React, { useCallback, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { create } from 'zustand'
import { createLogger } from '@kernel/log/contract'
import type { PanelPlacementOptions } from '@panels/framework/contract'
import { clientHas } from '@client/connections'
import type { RefTarget } from '@workspace/files/client'
import type { FileLineLocation } from '@workspace/files/contract'
import { isAnyFileDrag, resolveFileDrop, takeFileDrop } from '@workspace/files/ui'

export type FileDropKind = 'canvas' | 'dock' | 'terminal' | 'agent' | 'chat'

const log = createLogger('file-drop')

// --- Resolving drops ------------------------------------------------------------

export interface FileDropHandler {
  /** Opens workspace files where they were dropped (the editor's module
   *  installs this). `location` reveals a line in the file it names. */
  openFiles(workspaceId: string, paths: string[], placement: PanelPlacementOptions, location?: FileLineLocation | null): void
  /** A copy into the workspace started; `done` settles when it finished
   *  (the shell blocks quitting until then). */
  importing?(workspaceId: string, done: Promise<unknown>): void
}

let handler: FileDropHandler | null = null

export function installFileDropHandler(next: FileDropHandler | null): void {
  handler = next
}

/** The files a drop brings into `target`, as paths it can use, or null when
 *  the drop carries none (or only OS files this client cannot take). Call it
 *  in the drop handler: it takes the drop synchronously. */
export function dropFilesInto(target: RefTarget, dataTransfer: DataTransfer): Promise<{ paths: string[]; location: FileLineLocation | null }> | null {
  const drop = takeFileDrop(dataTransfer)
  if (!drop || (drop.os.length > 0 && !clientHas('fileDrop'))) return null
  const done = resolveFileDrop(drop, target)
  handler?.importing?.(target.workspaceId, done.catch(() => {}))
  return done
}

/** Drop handling for a dock or canvas: opens the dropped files there. */
export function useDockFileDrop(workspaceId: string, placement: () => PanelPlacementOptions) {
  const onDragOver = useCallback((e: React.DragEvent<HTMLElement>) => {
    if (!isAnyFileDrag(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }, [])
  const onDrop = useCallback((e: React.DragEvent<HTMLElement>) => {
    if (!handler) return
    const at = placement()
    const dropped = dropFilesInto({ workspaceId }, e.dataTransfer)
    if (!dropped) return
    e.preventDefault()
    e.stopPropagation()
    void dropped.then(
      ({ paths, location }) => { if (paths.length > 0) handler?.openFiles(workspaceId, paths, at, location) },
      (error) => { log.error('drop failed:', error) },
    )
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
  return isAnyFileDrag(e)
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
  chat: 'Drop to attach',
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
