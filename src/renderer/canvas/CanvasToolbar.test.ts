// =============================================================================
// Regression tests for the minimap section of CanvasToolbar.
//
// These are source-level assertions rather than full React renders — the
// toolbar pulls in heavy renderer modules (xterm, electron-log, the canvas
// store context tree) that aren't worth wiring up just to verify structural
// invariants.
// =============================================================================

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

const SOURCE = readFileSync(
  resolve(__dirname, 'CanvasToolbar.tsx'),
  'utf8',
)

describe('CanvasToolbar — minimap section', () => {
  it('does not force a hard-coded theme on the minimap container (must inherit the active app theme)', () => {
    const minimapStart = SOURCE.indexOf('<Minimap')
    expect(minimapStart).toBeGreaterThan(-1)

    const wrapperBlock = SOURCE.slice(Math.max(0, minimapStart - 600), minimapStart)
    expect(wrapperBlock).not.toMatch(/data-theme=/)
  })

  it('drives the popover open/close from the transient uiStore, not from a persisted setting', () => {
    expect(SOURCE).toMatch(/toggleMinimapOpen/)
    expect(SOURCE).not.toMatch(/saveSetting\(['"]showMinimap['"]/)
    expect(SOURCE).not.toMatch(/setSetting\(['"]showMinimap['"]/)
  })

  it('always renders the minimap button (not gated by a setting)', () => {
    expect(SOURCE).toContain('<MapTrifold')
    expect(SOURCE).not.toMatch(/\{showMinimap && \(/)
  })

  it('collapses from measured overlap and expands vertically from the bottom-right', () => {
    expect(SOURCE).toContain('horizontalCardRef.current')
    expect(SOURCE).toContain('shrink-0 w-max pointer-events-auto')
    expect(SOURCE).toContain('centeredRight <= areaWidth - bottomRightInset')
    expect(SOURCE).toContain('className="absolute bottom-4 z-50 pointer-events-none"')
    expect(SOURCE).toContain("style={{ right: '1rem' }}")
    expect(SOURCE).toContain('card.isConnected && card.offsetWidth > 0')
    expect(SOURCE).not.toContain('onMouseEnter={() => setHovered(true)}')
  })
})
