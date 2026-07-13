// =============================================================================
// Regression tests for the minimap — which now lives in the command palette
// (a collapsible card at its foot) rather than as a floating pill on the
// canvas toolbar.
//
// These are source-level assertions rather than full React renders — both
// modules pull in heavy renderer dependencies (xterm, electron-log, the canvas
// store context tree) that aren't worth wiring up just to verify structural
// invariants.
// =============================================================================

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

const TOOLBAR_SOURCE = readFileSync(
  resolve(__dirname, 'CanvasToolbar.tsx'),
  'utf8',
)
const PALETTE_SOURCE = readFileSync(
  resolve(__dirname, '../ui/CommandPalette.tsx'),
  'utf8',
)

describe('CanvasToolbar — no minimap', () => {
  it('no longer renders the minimap or its toggle on the canvas toolbar', () => {
    expect(TOOLBAR_SOURCE).not.toContain('<Minimap')
    expect(TOOLBAR_SOURCE).not.toContain('minimap-toggle')
  })
})

describe('CommandPalette — minimap card', () => {
  it('renders the minimap in popover mode for the active canvas', () => {
    const minimapStart = PALETTE_SOURCE.indexOf('<Minimap mode="popover"')
    expect(minimapStart).toBeGreaterThan(-1)

    // The card must be wrapped in a CanvasStoreProvider so it previews the
    // resolved active canvas rather than a mount-time context store.
    const wrapperBlock = PALETTE_SOURCE.slice(Math.max(0, minimapStart - 400), minimapStart)
    expect(wrapperBlock).toContain('CanvasStoreProvider')
    // Must not pin a hard-coded theme onto the container.
    expect(wrapperBlock).not.toMatch(/data-theme=/)
  })

  it('is always shown (not collapsible) and not gated by a persisted setting', () => {
    // No collapse state — the card is always rendered when a canvas exists.
    expect(PALETTE_SOURCE).not.toMatch(/minimapOpen/)
    expect(PALETTE_SOURCE).not.toMatch(/saveSetting\(['"]showMinimap['"]/)
    expect(PALETTE_SOURCE).not.toMatch(/setSetting\(['"]showMinimap['"]/)
  })

  it('offers a tab per workspace canvas and highlights the shown one', () => {
    expect(PALETTE_SOURCE).toMatch(/canvasTabs/)
    expect(PALETTE_SOURCE).toMatch(/setSelectedCanvasId/)
  })

  it('dismisses the palette after a navigate gesture', () => {
    expect(PALETTE_SOURCE).toMatch(/onNavigateEnd=\{close\}/)
  })
})
