// Toolbar entries other modules add to every canvas toolbar (the worktree
// menu, the T3 conversation menu), so the canvas never imports them.

import type React from 'react'

export interface CanvasToolbarItemProps {
  workspaceId: string
  canvasId: string
  canvasPanelId: string
  tooltipPlacement: 'top' | 'right'
  menuSide: 'up' | 'right'
  /** An open fly-out keeps a compact toolbar expanded. */
  onOpenChange(open: boolean): void
}

export interface CanvasToolbarItem {
  id: string
  /** 'tools' sits after the select and hand tools; 'create' after the new
   *  panel buttons. */
  group: 'tools' | 'create'
  order: number
  Component: React.ComponentType<CanvasToolbarItemProps>
}

const items = new Map<string, CanvasToolbarItem>()
const listeners = new Set<() => void>()
let snapshot: CanvasToolbarItem[] = []

export function registerCanvasToolbarItem(item: CanvasToolbarItem): () => void {
  items.set(item.id, item)
  snapshot = [...items.values()].sort((a, b) => a.order - b.order)
  for (const listener of [...listeners]) listener()
  return () => {
    if (items.get(item.id) !== item) return
    items.delete(item.id)
    snapshot = [...items.values()].sort((a, b) => a.order - b.order)
    for (const listener of [...listeners]) listener()
  }
}

export function canvasToolbarItems(): CanvasToolbarItem[] {
  return snapshot
}

export function subscribeCanvasToolbarItems(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
