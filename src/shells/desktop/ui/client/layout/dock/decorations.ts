// What other modules add to dock tabs and panel chrome without the dock
// knowing them: a tab's logo, status mark and title, a dirty mark, extra tab
// menu items, and the overlays over a panel's top-right corner. Register at startup, before
// the first dock renders: decoration hooks run as React hooks.

import type { ComponentType, ReactNode } from 'react'
import type { PanelRecord } from '@workspace/document/contract'
import type { ContextMenuItem } from '@kernel/interaction/contract'

export interface TabDecoration {
  /** Replaces the type icon. */
  logo?: string | null
  logoAlt?: string | null
  /** A status mark drawn after the title. */
  status?: ReactNode
  /** The title ends with a dot (unsaved changes). */
  dirty?: boolean
  /** The title to show for the record's title. */
  retitle?: (title: string) => string
}

/** A React hook: decorations for the workspace's panels, keyed by id. */
export type TabDecorationHook = (workspaceId: string) => Readonly<Record<string, TabDecoration>>

const decorationHooks: TabDecorationHook[] = []

export function registerTabDecorations(hook: TabDecorationHook): () => void {
  decorationHooks.push(hook)
  return () => {
    const index = decorationHooks.indexOf(hook)
    if (index >= 0) decorationHooks.splice(index, 1)
  }
}

/** Every registered decoration merged per panel. */
export function useTabDecorations(workspaceId: string): Record<string, TabDecoration> {
  const out: Record<string, TabDecoration> = {}
  for (const hook of decorationHooks) {
    for (const [panelId, decoration] of Object.entries(hook(workspaceId))) {
      out[panelId] = { ...out[panelId], ...decoration }
    }
  }
  return out
}

// --- Tab menu items ------------------------------------------------------------

export interface TabMenuContext {
  workspaceId: string
  record: PanelRecord
}

export interface TabMenuContribution {
  /** Items shown above Rename, in order; ids must be unique across providers. */
  items(context: TabMenuContext): ContextMenuItem[]
  /** Runs a chosen item; returns true when it was this provider's. */
  run(id: string, context: TabMenuContext): boolean | Promise<boolean>
}

const menuContributions: TabMenuContribution[] = []

export function registerTabMenuItems(contribution: TabMenuContribution): () => void {
  menuContributions.push(contribution)
  return () => {
    const index = menuContributions.indexOf(contribution)
    if (index >= 0) menuContributions.splice(index, 1)
  }
}

export function tabMenuContributions(): readonly TabMenuContribution[] {
  return menuContributions
}

// --- Chrome overlays -----------------------------------------------------------

/** Drawn over the top-right corner of a panel whose definition asks for the
 *  worktree chip, unless the view claims the corner. */
export type PanelChromeOverlay = ComponentType<{ workspaceId: string; record: PanelRecord }>

const overlays: PanelChromeOverlay[] = []

export function registerPanelChromeOverlay(overlay: PanelChromeOverlay): () => void {
  overlays.push(overlay)
  return () => {
    const index = overlays.indexOf(overlay)
    if (index >= 0) overlays.splice(index, 1)
  }
}

export function panelChromeOverlays(): readonly PanelChromeOverlay[] {
  return overlays
}
