// The contract between a panel view and the host that draws chrome over it.
// The dock overlays the worktree chip on the panel's top-right; a view that
// keeps its own UI in that corner claims it and the chip stands down while the
// claim is held. Panels report; the host decides.

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
