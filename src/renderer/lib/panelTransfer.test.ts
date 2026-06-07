// Regression tests for what a PanelTransferSnapshot must carry across a
// cross-window move: editor unsaved content, canvas children (including tabbed
// ones), and — the live-process part — each child terminal's PTY id + scrollback
// so the receiver reconnects instead of spawning a fresh shell.

// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Controllable terminal registry: getEntry drives which children look like live
// terminals; captureScrollback / setPendingTransfer are spied.
const entries: Record<string, { ptyId: string }> = {}
const captureScrollback = vi.fn(() => 'SCROLLBACK')
const setPendingTransfer = vi.fn()
vi.mock('./terminal/terminalRegistry', () => ({
  terminalRegistry: {
    getEntry: (id: string) => entries[id],
    captureScrollback: (...a: unknown[]) => captureScrollback(...(a as [])),
    setPendingTransfer: (...a: unknown[]) => setPendingTransfer(...(a as [])),
  },
}))

// Controllable node dock layout so we can exercise tabbed (non-seed) children.
const getNodeDockLayout = vi.fn<() => unknown>(() => null)
vi.mock('./workspace/canvasAccess', () => ({
  getNodeDockLayout: () => getNodeDockLayout(),
}))

import { createTransferSnapshot, depositCanvasChildTransfers } from './panelTransfer'
import { getOrCreateCanvasStoreForPanel } from '../stores/canvasStore'
import { terminalRestoreData } from './terminal/terminalRestoreData'
import type { PanelState } from '../../shared/types'

beforeEach(() => {
  for (const k of Object.keys(entries)) delete entries[k]
  captureScrollback.mockClear()
  setPendingTransfer.mockClear()
  getNodeDockLayout.mockReturnValue(null)
})

describe('createTransferSnapshot — editor content survival', () => {
  it('captures unsaved scratch-editor content into editorState.unsavedContent', () => {
    const panel: PanelState = {
      id: 'panel-editor-1',
      type: 'editor',
      title: 'Untitled',
      isDirty: true,
      unsavedContent: 'function hello() { return 42 }',
    }
    const snapshot = createTransferSnapshot(panel, { type: 'canvas', canvasId: 'c-1', canvasNodeId: 'n-1' }, {
      origin: { x: 0, y: 0 },
      size: { width: 600, height: 400 },
    })

    expect(snapshot.editorState?.unsavedContent).toBe('function hello() { return 42 }')
  })
})

describe('createTransferSnapshot — canvas children survival', () => {
  it('captures the canvas store nodes + viewport + child PanelState', () => {
    const panel: PanelState = { id: 'panel-canvas-1', type: 'canvas', title: 'Sub-canvas', isDirty: false }
    const store = getOrCreateCanvasStoreForPanel(panel.id)
    const nodeId = store.getState().addNode('child-panel-1', 'terminal', { x: 100, y: 80 }, { width: 320, height: 240 })
    store.setState({ zoomLevel: 1.5, viewportOffset: { x: 12, y: 34 } })

    const childPanel: PanelState = { id: 'child-panel-1', type: 'terminal', title: 'zsh', isDirty: false }
    const snapshot = createTransferSnapshot(
      panel,
      { type: 'canvas', canvasId: 'c-root', canvasNodeId: 'n-root' },
      { origin: { x: 0, y: 0 }, size: { width: 800, height: 600 } },
      { resolveChildPanel: (id) => (id === childPanel.id ? childPanel : undefined) },
    )

    expect(snapshot.canvasState?.zoomLevel).toBe(1.5)
    expect(snapshot.canvasState?.viewportOffset).toEqual({ x: 12, y: 34 })
    expect(snapshot.canvasState?.nodes[nodeId].panelId).toBe('child-panel-1')
    expect(snapshot.canvasState?.childPanels['child-panel-1']).toEqual(childPanel)
  })

  // Live-process transfer: a running child terminal's PTY + scrollback must ride
  // along so the receiver reconnects instead of spawning a fresh shell.
  it('captures each child terminal PTY id + scrollback into childTerminals', () => {
    const panel: PanelState = { id: 'canvas-x', type: 'canvas', title: 'C', isDirty: false }
    const store = getOrCreateCanvasStoreForPanel(panel.id)
    store.getState().addNode('term-child', 'terminal', { x: 0, y: 0 }, { width: 300, height: 200 })
    entries['term-child'] = { ptyId: 'pty-99' }

    const snapshot = createTransferSnapshot(
      panel,
      { type: 'canvas', canvasId: 'c', canvasNodeId: 'n' },
      { origin: { x: 0, y: 0 }, size: { width: 800, height: 600 } },
      { resolveChildPanel: (id) => ({ id, type: 'terminal', title: 't', isDirty: false }) },
    )

    expect(snapshot.canvasState?.childTerminals?.['term-child']).toEqual({
      ptyId: 'pty-99',
      scrollback: 'SCROLLBACK',
    })
  })

  // Tabbed children (non-seed panels in a node's mini-dock) must transfer too.
  it('captures tabbed children via the node dock layout, not just node.panelId', () => {
    const panel: PanelState = { id: 'canvas-y', type: 'canvas', title: 'C', isDirty: false }
    const store = getOrCreateCanvasStoreForPanel(panel.id)
    store.getState().addNode('seed', 'terminal', { x: 0, y: 0 }, { width: 300, height: 200 })
    // Node's mini-dock holds two tabs; only 'seed' is the node's seed panel.
    getNodeDockLayout.mockReturnValue({ type: 'tabs', panelIds: ['seed', 'tab2'] })

    const snapshot = createTransferSnapshot(
      panel,
      { type: 'canvas', canvasId: 'c', canvasNodeId: 'n' },
      { origin: { x: 0, y: 0 }, size: { width: 800, height: 600 } },
      { resolveChildPanel: (id) => ({ id, type: 'terminal', title: id, isDirty: false }) },
    )

    expect(Object.keys(snapshot.canvasState?.childPanels ?? {}).sort()).toEqual(['seed', 'tab2'])
  })

  it('omits canvasState for non-canvas panels', () => {
    const panel: PanelState = { id: 'panel-term-1', type: 'terminal', title: 'zsh', isDirty: false }
    const snapshot = createTransferSnapshot(
      panel,
      { type: 'canvas', canvasId: 'c-1', canvasNodeId: 'n-1' },
      { origin: { x: 0, y: 0 }, size: { width: 400, height: 300 } },
    )
    expect(snapshot.canvasState).toBeUndefined()
  })
})

describe('depositCanvasChildTransfers — receiver reconnect', () => {
  it('arms a pending transfer for each child terminal so it reconnects on mount', () => {
    depositCanvasChildTransfers({
      nodes: {},
      viewportOffset: { x: 0, y: 0 },
      zoomLevel: 1,
      childPanels: {},
      childTerminals: {
        a: { ptyId: 'pty-a', scrollback: 'AA' },
        b: { ptyId: 'pty-b' },
      },
    })

    expect(setPendingTransfer).toHaveBeenCalledWith('a', 'pty-a', 'AA')
    expect(setPendingTransfer).toHaveBeenCalledWith('b', 'pty-b', undefined)
  })

  it('no-ops when there are no child terminals', () => {
    depositCanvasChildTransfers(undefined)
    expect(setPendingTransfer).not.toHaveBeenCalled()
  })

  // Cold restore: a child terminal carries `replayPtyId` (its dead PTY) instead
  // of a live `ptyId`, so the receiver must seed terminalRestoreData to spawn a
  // fresh PTY and replay that log — NOT reconnect via setPendingTransfer.
  it('seeds terminalRestoreData for replayPtyId children and reconnects ptyId ones', () => {
    terminalRestoreData.clear()
    depositCanvasChildTransfers({
      nodes: {},
      viewportOffset: { x: 0, y: 0 },
      zoomLevel: 1,
      childPanels: {},
      childTerminals: {
        live: { ptyId: 'pty-live', scrollback: 'LL' },
        dead: { replayPtyId: 'pty-dead' },
      },
    })

    // Live entry reconnects; restore entry replays.
    expect(setPendingTransfer).toHaveBeenCalledWith('live', 'pty-live', 'LL')
    expect(setPendingTransfer).not.toHaveBeenCalledWith('dead', expect.anything(), expect.anything())
    expect(terminalRestoreData.get('dead')).toEqual({ replayFromId: 'pty-dead' })
    expect(terminalRestoreData.has('live')).toBe(false)
    terminalRestoreData.clear()
  })
})
