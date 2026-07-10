import { describe, it, expect, beforeEach, vi } from 'vitest'

const removePanelRecord = vi.fn()
const releaseCanvasStoreForPanel = vi.fn()
const release = vi.fn()
const dispose = vi.fn()
const disposeAgentPanel = vi.fn()
const canvasNodes: Record<string, { id: string; dockLayout: { type: 'tabs'; id: string; panelIds: string[]; activeIndex: number } }> = {}
// Per-id panel types resolved by the child agent-dispose lookup.
const panelTypes: Record<string, string> = {}

vi.mock('../../stores/appStore', () => ({
  useAppStore: {
    getState: () => ({
      removePanelRecord,
      workspaces: [
        {
          id: 'ws-1',
          panels: Object.fromEntries(
            Object.entries(panelTypes).map(([id, type]) => [id, { id, type }]),
          ),
        },
      ],
    }),
  },
}))

vi.mock('../../../agent/renderer/agentSessionRegistry', () => ({
  disposeAgentPanel: (id: string) => disposeAgentPanel(id),
}))

vi.mock('../../stores/canvasStore', () => ({
  getOrCreateCanvasStoreForPanel: () => ({ getState: () => ({ nodes: canvasNodes }) }),
  peekCanvasStoreForPanel: () => ({ getState: () => ({
    nodes: canvasNodes,
    zoomLevel: 1,
    viewportOffset: { x: 0, y: 0 },
  }) }),
  releaseCanvasStoreForPanel: (id: string) => releaseCanvasStoreForPanel(id),
}))

// Force the persisted node dock layout path (no live mini-dock layout).
vi.mock('../workspace/canvasAccess', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../workspace/canvasAccess')>()),
  getNodeDockLayout: () => null,
}))

vi.mock('../terminal/terminalRegistry', () => ({
  terminalRegistry: {
    release: (id: string) => release(id),
    dispose: (id: string) => dispose(id),
  },
}))

import { removePanelFromWindow } from './removePanelFromWindow'

function setCanvasNodes(children: string[]) {
  for (const k of Object.keys(canvasNodes)) delete canvasNodes[k]
  children.forEach((panelId, i) => {
    canvasNodes[`n${i}`] = {
      id: `n${i}`,
      dockLayout: { type: 'tabs', id: `s${i}`, panelIds: [panelId], activeIndex: 0 },
    }
  })
}

function setPanelTypes(types: Record<string, string>) {
  for (const k of Object.keys(panelTypes)) delete panelTypes[k]
  Object.assign(panelTypes, types)
}

describe('removePanelFromWindow', () => {
  beforeEach(() => {
    removePanelRecord.mockReset()
    releaseCanvasStoreForPanel.mockReset()
    release.mockReset()
    dispose.mockReset()
    disposeAgentPanel.mockReset()
    setCanvasNodes([])
    setPanelTypes({})
  })

  it('transfer: drops the record and releases (not disposes) a terminal panel', () => {
    removePanelFromWindow('ws-1', 'term1', 'terminal', 'transfer')
    expect(removePanelRecord).toHaveBeenCalledTimes(1)
    expect(removePanelRecord).toHaveBeenCalledWith('ws-1', 'term1')
    expect(release).toHaveBeenCalledWith('term1') // PTY survives the transfer
    expect(dispose).not.toHaveBeenCalled()
    expect(releaseCanvasStoreForPanel).not.toHaveBeenCalled()
  })

  it('transfer: drops the canvas, its children, releases child xterms + the canvas store', () => {
    setCanvasNodes(['term1', 'term2'])
    removePanelFromWindow('ws-1', 'canvasA', 'canvas', 'transfer')

    expect(removePanelRecord).toHaveBeenCalledWith('ws-1', 'term1')
    expect(removePanelRecord).toHaveBeenCalledWith('ws-1', 'term2')
    expect(removePanelRecord).toHaveBeenCalledWith('ws-1', 'canvasA')
    // Child xterms are released (PTY kept alive for the transfer).
    expect(release).toHaveBeenCalledWith('term1')
    expect(release).toHaveBeenCalledWith('term2')
    expect(dispose).not.toHaveBeenCalled()
    expect(releaseCanvasStoreForPanel).toHaveBeenCalledWith('canvasA')
  })

  it('transfer: disposes an agent child so its pi does not leak into the detached window', () => {
    setCanvasNodes(['term1', 'agent1'])
    setPanelTypes({ term1: 'terminal', agent1: 'agent' })
    removePanelFromWindow('ws-1', 'canvasA', 'canvas', 'transfer')

    // Only the agent child gets its pi chats disposed; the terminal is just
    // released (PTY survives the transfer).
    expect(disposeAgentPanel).toHaveBeenCalledTimes(1)
    expect(disposeAgentPanel).toHaveBeenCalledWith('agent1')
    expect(release).toHaveBeenCalledWith('term1')
    expect(release).toHaveBeenCalledWith('agent1')
    expect(removePanelRecord).toHaveBeenCalledWith('ws-1', 'agent1')
  })

  it('close: disposes (kills PTY) instead of releasing, for the panel and canvas children', () => {
    setCanvasNodes(['term1', 'agent1'])
    setPanelTypes({ term1: 'terminal', agent1: 'agent' })
    removePanelFromWindow('ws-1', 'canvasA', 'canvas', 'close')

    expect(dispose).toHaveBeenCalledWith('term1')
    expect(dispose).toHaveBeenCalledWith('agent1') // no-op for non-terminals
    expect(dispose).toHaveBeenCalledWith('canvasA')
    expect(release).not.toHaveBeenCalled()
    expect(disposeAgentPanel).toHaveBeenCalledWith('agent1')
    expect(removePanelRecord).toHaveBeenCalledWith('ws-1', 'term1')
    expect(removePanelRecord).toHaveBeenCalledWith('ws-1', 'agent1')
    expect(removePanelRecord).toHaveBeenCalledWith('ws-1', 'canvasA')
    expect(releaseCanvasStoreForPanel).toHaveBeenCalledWith('canvasA')
  })
})
