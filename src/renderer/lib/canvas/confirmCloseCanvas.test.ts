import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mutable test state, swapped per-case before importing the helper's deps.
const state = {
  workspaces: [] as Array<{ id: string; panels: Record<string, { id: string; type: string }> }>,
}
const closePanel = vi.fn()
const addNode = vi.fn()
const canvasNodes: Record<string, { id: string; panelId: string; origin: { x: number; y: number } }> = {}

vi.mock('../../stores/appStore', () => ({
  useAppStore: { getState: () => ({ workspaces: state.workspaces, closePanel }) },
}))

vi.mock('../../stores/canvasStore', () => ({
  getOrCreateCanvasStoreForPanel: () => ({
    getState: () => ({ nodes: canvasNodes, addNode }),
  }),
}))

// Force the seed-panelId fallback path (no live mini-dock layout).
vi.mock('../workspace/canvasAccess', () => ({
  getNodeDockLayout: () => null,
}))

import { confirmCloseCanvas } from './confirmCloseCanvas'

const confirmCloseCanvasDialog = vi.fn()

function setWorkspace(canvasIds: string[], childIds: string[]) {
  const panels: Record<string, { id: string; type: string }> = {}
  for (const id of canvasIds) panels[id] = { id, type: 'canvas' }
  for (const id of childIds) panels[id] = { id, type: 'terminal' }
  state.workspaces = [{ id: 'ws-1', panels }]
}

function setCanvasNodes(children: string[]) {
  for (const k of Object.keys(canvasNodes)) delete canvasNodes[k]
  children.forEach((panelId, i) => {
    canvasNodes[`n${i}`] = { id: `n${i}`, panelId, origin: { x: i, y: i } }
  })
}

describe('confirmCloseCanvas', () => {
  beforeEach(() => {
    closePanel.mockReset()
    addNode.mockReset()
    confirmCloseCanvasDialog.mockReset()
    ;(globalThis as unknown as { window: { electronAPI: unknown } }).window = {
      electronAPI: { confirmCloseCanvas: confirmCloseCanvasDialog },
    }
  })

  // Regression: closing the only canvas used to return true WITHOUT closing its
  // children, leaving them as ghost rows in the sidebar (in workspace.panels but
  // on no canvas). The 'close' choice must cascade-close the contained panels.
  it('closes contained children when the only canvas is closed', async () => {
    setWorkspace(['canvasA'], ['term1', 'term2'])
    setCanvasNodes(['term1', 'term2'])
    confirmCloseCanvasDialog.mockResolvedValue('close')

    const proceed = await confirmCloseCanvas('ws-1', 'canvasA')

    expect(proceed).toBe(true)
    expect(confirmCloseCanvasDialog).toHaveBeenCalledWith({ panelCount: 2, isLast: true })
    expect(closePanel).toHaveBeenCalledWith('ws-1', 'term1')
    expect(closePanel).toHaveBeenCalledWith('ws-1', 'term2')
  })

  it('does nothing to children and returns false on cancel', async () => {
    setWorkspace(['canvasA'], ['term1'])
    setCanvasNodes(['term1'])
    confirmCloseCanvasDialog.mockResolvedValue('cancel')

    const proceed = await confirmCloseCanvas('ws-1', 'canvasA')

    expect(proceed).toBe(false)
    expect(closePanel).not.toHaveBeenCalled()
  })

  it('closes children on the delete choice (multi-canvas)', async () => {
    setWorkspace(['canvasA', 'canvasB'], ['term1', 'term2'])
    setCanvasNodes(['term1', 'term2'])
    confirmCloseCanvasDialog.mockResolvedValue('delete')

    const proceed = await confirmCloseCanvas('ws-1', 'canvasA')

    expect(proceed).toBe(true)
    expect(confirmCloseCanvasDialog).toHaveBeenCalledWith({ panelCount: 2, isLast: false })
    expect(closePanel).toHaveBeenCalledWith('ws-1', 'term1')
    expect(closePanel).toHaveBeenCalledWith('ws-1', 'term2')
    expect(addNode).not.toHaveBeenCalled()
  })

  it('moves children to the other canvas on the move choice (does not close them)', async () => {
    setWorkspace(['canvasA', 'canvasB'], ['term1'])
    setCanvasNodes(['term1'])
    confirmCloseCanvasDialog.mockResolvedValue('move')

    const proceed = await confirmCloseCanvas('ws-1', 'canvasA')

    expect(proceed).toBe(true)
    expect(addNode).toHaveBeenCalledWith('term1', 'terminal', { x: 0, y: 0 })
    expect(closePanel).not.toHaveBeenCalled()
  })

  it('proceeds without prompting for an empty canvas with no electronAPI dialog', async () => {
    setWorkspace(['canvasA'], [])
    setCanvasNodes([])
    ;(globalThis as unknown as { window: { electronAPI: unknown } }).window = { electronAPI: {} }

    const proceed = await confirmCloseCanvas('ws-1', 'canvasA')
    expect(proceed).toBe(true)
    expect(closePanel).not.toHaveBeenCalled()
  })
})
