// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./terminal/terminalRegistry', () => ({
  terminalRegistry: { release: vi.fn(), setPendingTransfer: vi.fn(), dispose: vi.fn() },
}))
vi.mock('./logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
}))

import { getFocusedLeafPanelId } from './focusedPanel'
import { setActivePanel } from './activePanel'
import { useAppStore } from '../stores/appStore'
import {
  getOrCreateCanvasStoreForPanel,
  releaseCanvasStoreForPanel,
} from '../stores/canvasStore'
import {
  registerNodeDockStore,
  unregisterNodeDockStore,
} from '../panels/nodeDockRegistry'
import { createDockStore } from '../stores/dockStore'

const WS = 'ws-focused-panel'
const CANVAS = 'canvas-focused-panel'
const NODE_PANEL = 'node-editor'

beforeEach(() => {
  useAppStore.setState({
    selectedWorkspaceId: WS,
    workspaces: [{
      id: WS,
      rootPath: '/repo',
      panels: {
        [CANVAS]: { id: CANVAS, type: 'canvas', title: 'Canvas' },
        docked: { id: 'docked', type: 'terminal', title: 'Terminal' },
        [NODE_PANEL]: { id: NODE_PANEL, type: 'editor', title: 'Editor' },
      },
    }],
  } as never)
})

afterEach(() => {
  releaseCanvasStoreForPanel(CANVAS)
  setActivePanel(null)
  useAppStore.setState({ workspaces: [], selectedWorkspaceId: null } as never)
})

describe('getFocusedLeafPanelId', () => {
  it('returns the canonical active panel for a regular dock stack', () => {
    setActivePanel('docked')
    expect(getFocusedLeafPanelId()).toBe('docked')
  })

  it('descends from an active canvas into the focused node mini-dock', () => {
    const canvas = getOrCreateCanvasStoreForPanel(CANVAS)
    const nodeId = canvas.getState().addNode('seed', 'terminal')
    canvas.getState().focusNode(nodeId)

    const nodeDock = createDockStore()
    nodeDock.getState().dockPanel('seed', 'center')
    nodeDock.getState().dockPanel(NODE_PANEL, 'center')
    registerNodeDockStore(CANVAS, nodeId, nodeDock)

    setActivePanel(CANVAS)
    expect(getFocusedLeafPanelId()).toBe(NODE_PANEL)

    unregisterNodeDockStore(CANVAS, nodeId)
  })
})
