// Regression test for the user-reported "unsaved editor content vanishes
// when an editor panel is dragged to a detached window, but reappears when
// dragged back" bug. The transfer snapshot today only carries terminal and
// browser state — editor state is never captured, so the destination window
// renders a fresh Monaco editor with no unsavedContent.

// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'

vi.mock('./terminalRegistry', () => ({
  terminalRegistry: { getEntry: () => undefined },
}))

import { createTransferSnapshot } from './panelTransfer'
import { getOrCreateCanvasStoreForPanel } from '../stores/canvasStore'
import type { PanelState } from '../../shared/types'

describe('createTransferSnapshot — editor content survival', () => {
  // The source-of-truth for the bug: the editor's local React/Monaco buffer
  // holds unsavedContent that lives only in component state. When the panel
  // is transferred to a detached window the snapshot is the ONLY channel for
  // that content. If the snapshot doesn't carry it, it's gone.
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

    expect(snapshot.editorState).toBeDefined()
    expect(snapshot.editorState?.unsavedContent).toBe('function hello() { return 42 }')
  })
})

// Regression: detaching a canvas-type panel into its own window used to land
// on an empty canvas because the snapshot carried no children. Verify the
// snapshot now captures nodes / regions / viewport so the receiving window
// can hydrate before first paint.
describe('createTransferSnapshot — canvas children survival', () => {
  it('captures the canvas store nodes + regions + viewport for canvas panels', () => {
    const panel: PanelState = {
      id: 'panel-canvas-1',
      type: 'canvas',
      title: 'Sub-canvas',
      isDirty: false,
    }
    const store = getOrCreateCanvasStoreForPanel(panel.id)
    const nodeId = store.getState().addNode('child-panel-1', 'terminal', { x: 100, y: 80 }, { width: 320, height: 240 })
    store.setState({ zoomLevel: 1.5, viewportOffset: { x: 12, y: 34 } })

    const childPanel: PanelState = {
      id: 'child-panel-1',
      type: 'terminal',
      title: 'zsh',
      isDirty: false,
    }
    const snapshot = createTransferSnapshot(
      panel,
      { type: 'canvas', canvasId: 'c-root', canvasNodeId: 'n-root' },
      { origin: { x: 0, y: 0 }, size: { width: 800, height: 600 } },
      { resolveChildPanel: (id) => (id === childPanel.id ? childPanel : undefined) },
    )

    expect(snapshot.canvasState).toBeDefined()
    expect(snapshot.canvasState?.zoomLevel).toBe(1.5)
    expect(snapshot.canvasState?.viewportOffset).toEqual({ x: 12, y: 34 })
    expect(snapshot.canvasState?.nodes[nodeId]).toBeDefined()
    expect(snapshot.canvasState?.nodes[nodeId].panelId).toBe('child-panel-1')
    expect(snapshot.canvasState?.childPanels['child-panel-1']).toEqual(childPanel)
  })

  it('omits canvasState for non-canvas panels', () => {
    const panel: PanelState = {
      id: 'panel-term-1',
      type: 'terminal',
      title: 'zsh',
      isDirty: false,
    }
    const snapshot = createTransferSnapshot(
      panel,
      { type: 'canvas', canvasId: 'c-1', canvasNodeId: 'n-1' },
      { origin: { x: 0, y: 0 }, size: { width: 400, height: 300 } },
    )
    expect(snapshot.canvasState).toBeUndefined()
  })
})
