import { describe, it, expect, beforeEach, vi } from 'vitest'

const removePanelRecord = vi.fn()
const releaseCanvasStoreForPanel = vi.fn()
const release = vi.fn()
const canvasNodes: Record<string, { id: string; panelId: string }> = {}

vi.mock('../../stores/appStore', () => ({
  useAppStore: { getState: () => ({ removePanelRecord }) },
}))

vi.mock('../../stores/canvasStore', () => ({
  getOrCreateCanvasStoreForPanel: () => ({ getState: () => ({ nodes: canvasNodes }) }),
  releaseCanvasStoreForPanel: (id: string) => releaseCanvasStoreForPanel(id),
}))

// Force the node.panelId fallback (no live mini-dock layout).
vi.mock('../workspace/canvasAccess', () => ({ getNodeDockLayout: () => null }))

vi.mock('../terminal/terminalRegistry', () => ({
  terminalRegistry: { release: (id: string) => release(id) },
}))

import { removeDetachedPanelRecords } from './removeDetachedPanelRecords'

function setCanvasNodes(children: string[]) {
  for (const k of Object.keys(canvasNodes)) delete canvasNodes[k]
  children.forEach((panelId, i) => {
    canvasNodes[`n${i}`] = { id: `n${i}`, panelId }
  })
}

describe('removeDetachedPanelRecords', () => {
  beforeEach(() => {
    removePanelRecord.mockReset()
    releaseCanvasStoreForPanel.mockReset()
    release.mockReset()
    setCanvasNodes([])
  })

  it('drops only the panel record for a non-canvas panel', () => {
    removeDetachedPanelRecords('ws-1', 'term1', 'terminal')
    expect(removePanelRecord).toHaveBeenCalledTimes(1)
    expect(removePanelRecord).toHaveBeenCalledWith('ws-1', 'term1')
    expect(releaseCanvasStoreForPanel).not.toHaveBeenCalled()
  })

  it('drops the canvas, its children, releases child xterms + the canvas store', () => {
    setCanvasNodes(['term1', 'term2'])
    removeDetachedPanelRecords('ws-1', 'canvasA', 'canvas')

    expect(removePanelRecord).toHaveBeenCalledWith('ws-1', 'term1')
    expect(removePanelRecord).toHaveBeenCalledWith('ws-1', 'term2')
    expect(removePanelRecord).toHaveBeenCalledWith('ws-1', 'canvasA')
    // Child xterms are released (PTY kept alive for the transfer).
    expect(release).toHaveBeenCalledWith('term1')
    expect(release).toHaveBeenCalledWith('term2')
    expect(releaseCanvasStoreForPanel).toHaveBeenCalledWith('canvasA')
  })
})
