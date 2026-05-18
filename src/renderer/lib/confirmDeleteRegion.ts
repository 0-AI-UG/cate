// =============================================================================
// confirmDeleteRegion — prompts the user before deleting a region that has
// panels inside. Returns the user's choice so callers can branch between
// deleting contents along with the region or keeping the contents in place.
// =============================================================================

export type DeleteRegionChoice = 'with-contents' | 'region-only' | 'cancel'

export async function confirmDeleteRegion(panelCount: number): Promise<DeleteRegionChoice> {
  if (panelCount <= 0) return 'region-only'
  if (!window.electronAPI?.confirmDeleteRegion) return 'region-only'
  return window.electronAPI.confirmDeleteRegion({ panelCount })
}
