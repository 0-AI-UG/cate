// =============================================================================
// placementForActivePanel — multi-canvas routing regression.
//
// Bug: when the active panel was a canvas, placementForActivePanel returned
// `undefined` ("default canvas placement"), and the default routes to the
// workspace's PRIMARY canvas (the first canvas tab in the center zone). With a
// SECONDARY canvas tab active, every keyboard-created panel therefore landed on
// a hidden canvas — to the user, panel creation silently stopped working.
// The fix pins the placement to the active canvas explicitly.
// =============================================================================

import { describe, it, expect, afterEach } from 'vitest'
import {
  placementForActivePanel,
  getActiveCanvasPanelId,
} from './canvasAccess'
import { setActivePanel } from '../activePanel'
import { getOrCreateCanvasStoreForPanel, releaseCanvasStoreForPanel } from '../../stores/canvasStore'

const PRIMARY = 'canvas-primary'
const SECONDARY = 'canvas-secondary'

afterEach(() => {
  releaseCanvasStoreForPanel(PRIMARY)
  releaseCanvasStoreForPanel(SECONDARY)
  setActivePanel(null)
})

describe('placementForActivePanel with multiple canvases', () => {
  it('pins the placement to the ACTIVE canvas, not the primary one', () => {
    getOrCreateCanvasStoreForPanel(PRIMARY)
    getOrCreateCanvasStoreForPanel(SECONDARY)
    setActivePanel(SECONDARY)

    expect(placementForActivePanel()).toEqual({
      target: 'canvas',
      canvasPanelId: SECONDARY,
    })
  })

  it('pins to the primary canvas when that one is active', () => {
    getOrCreateCanvasStoreForPanel(PRIMARY)
    getOrCreateCanvasStoreForPanel(SECONDARY)
    setActivePanel(PRIMARY)

    expect(placementForActivePanel()).toEqual({
      target: 'canvas',
      canvasPanelId: PRIMARY,
    })
  })

  it('returns undefined when nothing is active', () => {
    expect(placementForActivePanel()).toBeUndefined()
  })

  it('getActiveCanvasPanelId resolves the active secondary canvas', () => {
    getOrCreateCanvasStoreForPanel(PRIMARY)
    getOrCreateCanvasStoreForPanel(SECONDARY)
    setActivePanel(SECONDARY)

    expect(getActiveCanvasPanelId()).toBe(SECONDARY)
  })
})
