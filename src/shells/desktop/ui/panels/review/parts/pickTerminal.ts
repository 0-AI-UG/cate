// Where a review agent runs: an existing terminal, or a new one at a spot the
// user picks through the panel targeting overlay.

import { pickPanelPlace } from '@client/host'
import type { PlaceTarget } from '@workspace/document/contract'

export type ReviewTerminalPlace = { terminalPanelId: string } | { at: PlaceTarget }

/** Null when the user cancelled. */
export async function pickReviewTerminal(workspaceId: string, panelId: string): Promise<ReviewTerminalPlace | null> {
  const place = await pickPanelPlace({ workspaceId, panelType: 'terminal', availability: 'both', sourcePanelId: panelId })
  if (!place) return null
  return place.kind === 'existing' ? { terminalPanelId: place.panelId } : { at: place.at }
}
