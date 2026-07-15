// =============================================================================
// Panel chrome — the contract between a panel and whatever host renders chrome
// on top of it.
//
// The host (DockTabStack) overlays the worktree chip on the panel's top-right.
// A panel that puts its own UI in that corner — the terminal's search row, say —
// reports the clash by claiming the corner, and the host's chrome stands down
// for as long as the claim is held.
//
// Panels report; the host decides. That keeps the host from having to know what
// any given panel keeps in its corner, and keeps panel-local widget state out of
// the global stores.
// =============================================================================

import React, { createContext, useContext, useEffect } from 'react'

export interface PanelChromeApi {
  /** Report whether the panel's own UI currently occupies its top-right corner. */
  setCornerClaimed: (claimed: boolean) => void
}

/** Panels rendered without a chrome host (detached dock windows, tests) claim
 *  into the void rather than needing to know whether a host is there. */
const NOOP: PanelChromeApi = { setCornerClaimed: () => {} }

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
