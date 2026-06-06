// =============================================================================
// fileDropTarget — single source of truth for the HTML5 file-drag drop
// indicator. A window-level tracker hit-tests the cursor against the nearest
// element marked [data-filedrop] (canvas / dock zone / agent panel) and
// publishes ONE active target; <FileDropOverlay/> renders a single indicator
// at that target's bounds. This mirrors the internal drag system's
// single-target model, so indicators never conflict, are correctly scoped, and
// clear on drop. Drop *handling* stays in the components; this is visual only.
// =============================================================================

import React, { useEffect } from 'react'
import { create } from 'zustand'

export type FileDropKind = 'canvas' | 'dock' | 'agent' | 'terminal'

interface FileDropTarget {
  kind: FileDropKind
  id: string
  rect: { left: number; top: number; width: number; height: number }
}

interface FileDropState {
  target: FileDropTarget | null
  set: (t: FileDropTarget | null) => void
}

const useFileDropStore = create<FileDropState>((set) => ({
  target: null,
  set: (target) => set({ target }),
}))

function isFileDrag(e: DragEvent): boolean {
  const types = e.dataTransfer?.types
  if (!types) return false
  return (
    types.includes('application/cate-file') ||
    types.includes('application/cate-files') ||
    types.includes('Files')
  )
}

/** Install window-level listeners that track the current file-drop target.
 *  Call once per window (e.g. in the main app shell). */
export function useFileDropTracker(): void {
  useEffect(() => {
    const onDragOver = (e: DragEvent): void => {
      if (!isFileDrag(e)) return
      e.preventDefault() // allow dropping anywhere a [data-filedrop] target exists
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null
      const host = el?.closest('[data-filedrop]') as HTMLElement | null
      const store = useFileDropStore.getState()
      if (!host) {
        if (store.target) store.set(null)
        return
      }
      const kind = host.getAttribute('data-filedrop') as FileDropKind
      const id = host.getAttribute('data-filedrop-id') ?? ''
      // Avoid churn: only recompute the rect when the target element changes.
      if (store.target && store.target.kind === kind && store.target.id === id) return
      const r = host.getBoundingClientRect()
      store.set({ kind, id, rect: { left: r.left, top: r.top, width: r.width, height: r.height } })
    }
    const clear = (): void => {
      if (useFileDropStore.getState().target) useFileDropStore.getState().set(null)
    }
    const onDragLeave = (e: DragEvent): void => {
      // relatedTarget null === cursor left the window entirely.
      if (!e.relatedTarget) clear()
    }
    // Capture phase: fire before any target handler's stopPropagation (the
    // terminal stops dragover/drop propagation), so the tracker always updates.
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
  agent: 'Drop file to add to chat',
  terminal: 'Drop to paste path',
}

/** Single indicator for the active file-drop target. Mirrors the internal
 *  drag indicator's dashed-blue style so file drops feel consistent. */
export const FileDropOverlay: React.FC = () => {
  const target = useFileDropStore((s) => s.target)
  if (!target) return null
  const { rect, kind } = target
  return (
    <div
      data-file-drop-indicator={kind}
      style={{
        position: 'fixed',
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
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
        {LABEL[kind]}
      </span>
    </div>
  )
}
