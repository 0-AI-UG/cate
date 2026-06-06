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

export const ACCENT_PALETTE: readonly AccentColor[] = [
  { name: 'Blue',   workspace: '#4a8ad0', vividRgb: [0, 128, 255] },
  { name: 'Red',    workspace: '#d05c5c', vividRgb: [255, 0, 0] },
  { name: 'Orange', workspace: '#e09040', vividRgb: [255, 128, 0] },
  { name: 'Yellow', workspace: '#d4b04a', vividRgb: [255, 255, 0] },
  { name: 'Green',  workspace: '#6bbf5c', vividRgb: [0, 255, 0] },
  { name: 'Teal',   workspace: '#5ab8b8', vividRgb: [0, 255, 255] },
  { name: 'Purple', workspace: '#a874c8', vividRgb: [170, 0, 255] },
  { name: 'Pink',   workspace: '#c87090', vividRgb: [255, 0, 128] },
]

/** Workspace accent hex list — parallel to `ACCENT_PALETTE`. */
export const ACCENT_COLORS = ACCENT_PALETTE.map((p) => p.workspace)

/** Hex → human name lookup for the workspace context menu. */
export const ACCENT_COLOR_NAMES: Record<string, string> = Object.fromEntries(
  ACCENT_PALETTE.map((p) => [p.workspace, p.name]),
)

/** Convert `#rrggbb` to `rgba(r, g, b, a)`. Falls through unchanged for
 *  inputs that don't match the hex shape so existing rgba values from
 *  persisted sessions keep working. */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return hex
  const n = parseInt(m[1], 16)
  const r = (n >> 16) & 0xff
  const g = (n >> 8) & 0xff
  const b = n & 0xff
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}
