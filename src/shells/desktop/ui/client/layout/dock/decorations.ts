// Dock menu contributions and panel chrome overlays. Title presentation
// is shared by every panel label through client/host.

import type { ComponentType } from 'react'
import type { PanelRecord } from '@workspace/document/contract'
import type { ContextMenuItem } from '@kernel/interaction/contract'

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
