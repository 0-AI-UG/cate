// The cross-window panel index: which window shows which panel. Derived from
// the document, never synced (architecture 4.3).

import {
  MAIN_WINDOW,
  dockPanels,
  panelsInWindow,
  type DocWindow,
  type PanelId,
  type WindowId,
  type WorkspaceDocument,
  windowDockPanels,
} from '@workspace/document/contract'

/** Every panel's window, canvas children included. */
export function panelWindowIndex(doc: WorkspaceDocument): Map<PanelId, WindowId> {
  const index = new Map<PanelId, WindowId>()
  for (const windowId of Object.keys(doc.windows)) {
    for (const panelId of panelsInWindow(doc, windowId)) index.set(panelId, windowId)
  }
  return index
}

/** The panels each window shows, in document order. */
export function panelsByWindow(doc: WorkspaceDocument): Record<WindowId, PanelId[]> {
  const out: Record<WindowId, PanelId[]> = {}
  for (const windowId of Object.keys(doc.windows)) out[windowId] = panelsInWindow(doc, windowId)
  return out
}

/** The detached windows, in document order. */
export function detachedWindows(doc: WorkspaceDocument): DocWindow[] {
  return Object.values(doc.windows).filter((window) => window.kind === 'detached')
}

/** A short name for a window: its first tab's title. */
export function windowTitle(doc: WorkspaceDocument, windowId: WindowId): string {
  if (windowId === MAIN_WINDOW) return 'Main'
  const first = windowDockPanels(doc.windows[windowId])[0]
  return (first && doc.panels[first]?.title) || 'Window'
}
