// =============================================================================
// Shared accent palette — single source of truth for workspace accents.
//
// Each slot has two presentations of the same logical hue:
//   - `workspace`: muted hex shown as a solid accent on workspace tabs
//   - `vividRgb`:  saturated RGB used at low alpha for tinted fills, so they
//                  still read as the named hue once flattened on the canvas.
//
// The slot list defines the order shown in every "Change Color" menu — sorted
// by main colors first (rainbow-ish), so red/orange/yellow live next to one
// another in the workspace context menu.
// =============================================================================

export interface AccentColor {
  name: string
  workspace: string
  vividRgb: readonly [number, number, number]
}
