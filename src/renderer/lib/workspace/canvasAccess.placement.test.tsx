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
  placementForBackgroundPanel,
  getActiveCanvasPanelId,
} from './canvasAccess'
import { setActivePanel } from '../activePanel'
import { getOrCreateCanvasStoreForPanel, releaseCanvasStoreForPanel } from '../../stores/canvasStore'
import { useAppStore } from '../../stores/appStore'

const PRIMARY = 'canvas-primary'
const SECONDARY = 'canvas-secondary'
const SOURCE = 'terminal-source'

afterEach(() => {
  releaseCanvasStoreForPanel(PRIMARY)
  releaseCanvasStoreForPanel(SECONDARY)
  setActivePanel(null)
  useAppStore.setState({ selectedWorkspaceId: '', workspaces: [] })
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

  it('background placement pins the active canvas without requesting focus', () => {
    getOrCreateCanvasStoreForPanel(PRIMARY)
    getOrCreateCanvasStoreForPanel(SECONDARY)
    setActivePanel(SECONDARY)
    useAppStore.setState({ selectedWorkspaceId: 'ws-active' })

    expect(placementForBackgroundPanel('ws-active')).toEqual({
      target: 'canvas',
      canvasPanelId: SECONDARY,
      focus: false,
    })
  })

  it('does not pin a visible canvas that belongs to another workspace', () => {
    getOrCreateCanvasStoreForPanel(SECONDARY)
    setActivePanel(SECONDARY)
    useAppStore.setState({ selectedWorkspaceId: 'ws-visible' })

    expect(placementForBackgroundPanel('ws-background')).toEqual({
      target: 'canvas',
      focus: false,
    })
  })

  it('pins a new group to the canvas containing its source panel id', () => {
    const canvas = getOrCreateCanvasStoreForPanel(PRIMARY)
    canvas.setState({
      nodes: {
        'source-node': {
          id: 'source-node',
          origin: { x: 100, y: 100 },
          size: { width: 640, height: 400 },
          zOrder: 0,
          creationIndex: 0,
          dockLayout: { id: 'source-tabs', type: 'tabs', panelIds: [SOURCE], activeIndex: 0 },
        },
      },
    })
    useAppStore.setState({
      selectedWorkspaceId: 'another-workspace',
      workspaces: [{
        id: 'ws-source',
        panels: {
          [PRIMARY]: { id: PRIMARY, type: 'canvas', title: 'Canvas', isDirty: false },
          [SOURCE]: { id: SOURCE, type: 'terminal', title: 'Terminal', isDirty: false },
        },
      }],
    } as any)

    expect(placementForBackgroundPanel('ws-source', SOURCE)).toEqual({
      target: 'canvas',
      canvasPanelId: PRIMARY,
      focus: false,
      placementGroupId: SOURCE,
    })
  })
})
