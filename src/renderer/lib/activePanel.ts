// =============================================================================
// activePanel — the one canonical fact about focus: which panel the user last
// activated, anywhere (a canvas, a docked tab, a split pane). It replaces the
// two parallel globals it grew out of — `activeCanvasPanelId` (which canvas is
// active) and `activeSurface` (canvas vs which dock stack) — with a single id.
//
// Everything else is DERIVED from it (see lib/workspace/canvasAccess.ts):
//   - getActiveCanvasPanelId() — the canvas to route canvas shortcuts to
//   - placementForActivePanel() — where a Cmd+T / Cmd+N panel should be created
//
// Granularity is the PANEL id, and for a canvas surface that id IS the canvas
// panel (a canvas is itself a center-zone dock tab). That's deliberate: a
// canvas-type active panel derives to "default canvas placement", while a
// docked panel derives to "tab into that panel's stack" via the dock store's
// panelLocations. So canvas-vs-dock disambiguation falls out of the panel type
// — no pointer-event capture/bubble ordering trick needed.
//
// Written from the real interaction surfaces: pointer-down on a canvas
// (CanvasPanel) or a dock stack (DockTabStack), a dock tab click, and the
// workspace/layout/session transitions that re-point it at the incoming canvas.
//
// A zustand store (not a bare module var) so reactive consumers can subscribe.
// Module-scoped, so it is automatically per-renderer-window: a detached panel /
// dock window has its own independent active panel.
// =============================================================================

import { create } from 'zustand'

interface ActivePanelStore {
  activePanelId: string | null
  setActivePanel: (panelId: string | null) => void
}

export const useActivePanelStore = create<ActivePanelStore>((set) => ({
  activePanelId: null,
  setActivePanel: (panelId) => set({ activePanelId: panelId }),
}))

export function setActivePanel(panelId: string | null): void {
  useActivePanelStore.getState().setActivePanel(panelId)
}

export function getActivePanelId(): string | null {
  return useActivePanelStore.getState().activePanelId
}

/** Forget the active panel if it's the one being removed (closed / collapsed),
 *  so a gone panel can't keep attracting newly-created panels or be reported as
 *  focused. No-op if some other panel is active. */
export function clearActivePanelIfMatches(panelId: string): void {
  const store = useActivePanelStore.getState()
  if (store.activePanelId === panelId) store.setActivePanel(null)
}
