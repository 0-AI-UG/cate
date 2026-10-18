// The contract between a panel view and the host that draws chrome over it.
// The dock overlays the worktree chip on the panel's top-right; a view that
// keeps its own UI in that corner claims it and the chip stands down while the
// claim is held. A one-panel window pane also has controls (maximize, drag,
// close) that float over its corner; a view with a toolbar of its own draws
// them there instead (`usePanelPaneControls`) and the floating ones stand
// down. Panels report; the host decides.

import React, { createContext, useContext, useEffect } from 'react'

export interface PanelChromeApi {
  /** Report whether the panel's own UI currently occupies its top-right corner. */
  setCornerClaimed: (claimed: boolean) => void
  /** The pane's controls for a view to draw in its own toolbar; null where the
   *  pane has none (several tabs, a canvas node, no chrome host). */
  paneControls: React.ReactNode
  /** Report whether the view draws `paneControls` itself. */
  setControlsClaimed: (claimed: boolean) => void
}

/** Panels rendered without a chrome host (detached dock windows, tests) claim
 *  into the void rather than needing to know whether a host is there. */
const NOOP: PanelChromeApi = { setCornerClaimed: () => {}, paneControls: null, setControlsClaimed: () => {} }

export const PanelChromeContext = createContext<PanelChromeApi>(NOOP)

export const PanelChromeProvider: React.FC<{
  api: PanelChromeApi
  /** Only the visible panel can clash with the host's chrome; hidden keep-alive
   *  slots are wired to the no-op so they can't hold a claim off-screen. */
  enabled: boolean
  children: React.ReactNode
}> = ({ api, enabled, children }) => (
  <PanelChromeContext.Provider value={enabled ? api : NOOP}>{children}</PanelChromeContext.Provider>
)

/** Claim the panel's top-right corner while `claimed` is true. Released on
 *  unmount, so every path that hides the claiming UI is covered. */
export function useClaimPanelCorner(claimed: boolean): void {
  const { setCornerClaimed } = useContext(PanelChromeContext)
  useEffect(() => {
    setCornerClaimed(claimed)
    return () => setCornerClaimed(false)
  }, [claimed, setCornerClaimed])
}

/** The pane's controls, to draw in the view's own toolbar (null when there are
 *  none). Drawing them claims them: the floating controls stand down until the
 *  view unmounts. */
export function usePanelPaneControls(): React.ReactNode {
  const { paneControls, setControlsClaimed } = useContext(PanelChromeContext)
  const present = paneControls !== null
  useEffect(() => {
    if (!present) return
    setControlsClaimed(true)
    return () => setControlsClaimed(false)
  }, [present, setControlsClaimed])
  return paneControls
}
