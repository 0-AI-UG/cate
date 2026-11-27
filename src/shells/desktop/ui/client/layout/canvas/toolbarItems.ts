// Toolbar entries other modules add to every canvas toolbar (the worktree
// menu), so the canvas never imports them.

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

// --- Spawn flyouts ------------------------------------------------------------
// A pop-over a module shows while the pointer rests on a panel type's
// new-panel button (the agents over the terminal button).

export interface SpawnFlyoutProps {
  workspaceId: string
  canvasId: string
  /** The side of the button the flyout opens on. */
  side: 'up' | 'left'
  /** Closes the flyout (after a pick). */
  onClose(): void
  /** Whether it shows anything; the button's tooltip steps aside while it does. */
  onShown(shown: boolean): void
}

export interface SpawnFlyout {
  panelType: string
  Component: React.ComponentType<SpawnFlyoutProps>
}

const flyouts = new Map<string, SpawnFlyout>()
const flyoutListeners = new Set<() => void>()

export function registerSpawnFlyout(flyout: SpawnFlyout): () => void {
  flyouts.set(flyout.panelType, flyout)
  for (const listener of [...flyoutListeners]) listener()
  return () => {
    if (flyouts.get(flyout.panelType) !== flyout) return
    flyouts.delete(flyout.panelType)
    for (const listener of [...flyoutListeners]) listener()
  }
}

export function spawnFlyoutFor(panelType: string): SpawnFlyout | undefined {
  return flyouts.get(panelType)
}

export function subscribeSpawnFlyouts(listener: () => void): () => void {
  flyoutListeners.add(listener)
  return () => { flyoutListeners.delete(listener) }
}

// --- Spawn menus --------------------------------------------------------------
// More ways to create a panel type a module offers in the canvas context menu:
// the type's entry becomes a submenu with its plain "New <label>" first, then
// these (the agents a new terminal can start as).

export interface SpawnTarget {
  workspaceId: string
  canvasId: string
  /** Canvas point for the new node's top-left (where the menu opened). */
  position: { x: number; y: number }
  worktreeId?: string
}

export interface SpawnMenuEntry {
  id: string
  label: string
  icon?: React.ReactNode
  create(target: SpawnTarget): void
}

export interface SpawnMenu {
  panelType: string
  /** Calls `listener` when the workspace's entries change; returns the undo. */
  watch(workspaceId: string, listener: () => void): () => void
  /** The entries now, in order; empty while they are not known yet. */
  entries(workspaceId: string): readonly SpawnMenuEntry[]
}

const spawnMenus = new Map<string, SpawnMenu>()

export function registerSpawnMenu(menu: SpawnMenu): () => void {
  spawnMenus.set(menu.panelType, menu)
  return () => { if (spawnMenus.get(menu.panelType) === menu) spawnMenus.delete(menu.panelType) }
}

export function spawnMenuFor(panelType: string): SpawnMenu | undefined {
  return spawnMenus.get(panelType)
}

export function allSpawnMenus(): readonly SpawnMenu[] {
  return [...spawnMenus.values()]
}
