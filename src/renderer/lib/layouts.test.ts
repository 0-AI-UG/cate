// @vitest-environment jsdom
// =============================================================================
// Tests for applying saved layouts to a canvas.
//
// Regression: a saved layout used to be rebuilt onto the workspace's PRIMARY
// (center) canvas regardless of which canvas the load targeted — restored panels
// also came back at default sizes, and `agent` panels were silently dropped.
// These tests pin the corrected behavior: panels land on the TARGET canvas at
// their saved origin + size, agents survive, and a non-empty target is cleared
// first.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../stores/appStore'
import { releaseCanvasStoreForPanel } from '../stores/canvasStore'
import {
  ensureCanvasOpsForPanel,
  unregisterCanvasOps,
  invalidateWorkspaceCanvasCache,
} from './workspace/canvasAccess'
import {
  getOrCreateWorkspaceDockStore,
  releaseWorkspaceDockStore,
} from './workspace/dockRegistry'
import { setActivePanel } from './activePanel'
import { loadLayoutIntoActiveCanvas, loadLayoutIntoCanvas, type LayoutSnapshot } from './layouts'

const WS = 'ws-layout'
const PRIMARY = 'canvas-primary'
const TARGET = 'canvas-target'

type LayoutNodeInput = LayoutSnapshot['nodes'][number]

function snapshot(nodes: LayoutNodeInput[]): LayoutSnapshot {
  return { nodes, zoomLevel: 1, viewportOffset: { x: 0, y: 0 } }
}

function mockLayout(snap: LayoutSnapshot) {
  ;(window as any).electronAPI = { layoutLoad: vi.fn().mockResolvedValue(snap) }
}

beforeEach(() => {
  ;(window as any).electronAPI = {}
  useAppStore.setState({
    selectedWorkspaceId: WS,
    workspaces: [
      {
        id: WS,
        rootPath: '/repo',
        panels: {
          [PRIMARY]: { id: PRIMARY, type: 'canvas', title: 'Canvas' },
          [TARGET]: { id: TARGET, type: 'canvas', title: 'Canvas 2' },
        },
      },
    ],
  } as any)
  // Dock PRIMARY into the center zone so it resolves as the workspace's primary
  // canvas — the canvas restored nodes would WRONGLY land on before the fix.
  getOrCreateWorkspaceDockStore(WS).getState().dockPanel(PRIMARY, 'center')
  ensureCanvasOpsForPanel(PRIMARY)
  ensureCanvasOpsForPanel(TARGET)
})

afterEach(() => {
  unregisterCanvasOps(PRIMARY)
  unregisterCanvasOps(TARGET)
  releaseCanvasStoreForPanel(PRIMARY)
  releaseCanvasStoreForPanel(TARGET)
  invalidateWorkspaceCanvasCache(WS)
  releaseWorkspaceDockStore(WS)
  setActivePanel(null)
  useAppStore.setState({ workspaces: [], selectedWorkspaceId: '' } as any)
  vi.restoreAllMocks()
})

describe('loadLayoutIntoCanvas', () => {
  it('routes restored panels onto the TARGET canvas, not the workspace primary', async () => {
    mockLayout(
      snapshot([{ panelType: 'terminal', origin: { x: 100, y: 100 }, size: { width: 300, height: 200 } }]),
    )
    const targetStore = ensureCanvasOpsForPanel(TARGET).storeApi
    const primaryStore = ensureCanvasOpsForPanel(PRIMARY).storeApi

    const ok = await loadLayoutIntoCanvas('L', WS, TARGET, targetStore)

    expect(ok).toBe(true)
    expect(Object.values(targetStore.getState().nodes)).toHaveLength(1)
    expect(Object.values(primaryStore.getState().nodes)).toHaveLength(0)
  })

  it('restores each panel at its saved origin and size', async () => {
    mockLayout(
      snapshot([{ panelType: 'terminal', origin: { x: 120, y: 80 }, size: { width: 360, height: 240 } }]),
    )
    const targetStore = ensureCanvasOpsForPanel(TARGET).storeApi

    await loadLayoutIntoCanvas('L', WS, TARGET, targetStore)

    const node = Object.values(targetStore.getState().nodes)[0]
    expect(node.origin).toEqual({ x: 120, y: 80 })
    expect(node.size).toEqual({ width: 360, height: 240 })
  })

  it('recreates agent panels instead of dropping them', async () => {
    mockLayout(
      snapshot([{ panelType: 'agent', origin: { x: 200, y: 200 }, size: { width: 400, height: 300 } }]),
    )
    const targetStore = ensureCanvasOpsForPanel(TARGET).storeApi

    await loadLayoutIntoCanvas('L', WS, TARGET, targetStore)

    const nodes = Object.values(targetStore.getState().nodes)
    expect(nodes).toHaveLength(1)
    const panelId = nodes[0].panelId
    const ws = useAppStore.getState().workspaces.find((w) => w.id === WS)
    expect(ws?.panels[panelId]?.type).toBe('agent')
  })

  it('clears the target canvas (and its panel records) before applying', async () => {
    const targetStore = ensureCanvasOpsForPanel(TARGET).storeApi
    // Pre-seed an existing editor panel on the target canvas.
    useAppStore
      .getState()
      .createEditor(WS, undefined, { x: 0, y: 0 }, { target: 'canvas', canvasPanelId: TARGET })
    expect(Object.values(targetStore.getState().nodes)).toHaveLength(1)
    const stalePanelId = Object.values(targetStore.getState().nodes)[0].panelId

    mockLayout(
      snapshot([{ panelType: 'terminal', origin: { x: 100, y: 100 }, size: { width: 300, height: 200 } }]),
    )
    await loadLayoutIntoCanvas('L', WS, TARGET, targetStore)

    const nodes = Object.values(targetStore.getState().nodes)
    expect(nodes).toHaveLength(1)
    expect(nodes[0].panelId).not.toBe(stalePanelId)
    const ws = useAppStore.getState().workspaces.find((w) => w.id === WS)
    expect(ws?.panels[stalePanelId]).toBeUndefined()
  })

  it('returns false when the layout does not exist', async () => {
    ;(window as any).electronAPI = { layoutLoad: vi.fn().mockResolvedValue(null) }
    const targetStore = ensureCanvasOpsForPanel(TARGET).storeApi

    const ok = await loadLayoutIntoCanvas('missing', WS, TARGET, targetStore)

    expect(ok).toBe(false)
  })
})

describe('loadLayoutIntoActiveCanvas', () => {
  it('loads into the active canvas (not the workspace primary)', async () => {
    // Make TARGET the active canvas; PRIMARY remains the workspace primary.
    setActivePanel(TARGET)
    mockLayout(
      snapshot([{ panelType: 'terminal', origin: { x: 140, y: 60 }, size: { width: 320, height: 220 } }]),
    )
    const targetStore = ensureCanvasOpsForPanel(TARGET).storeApi
    const primaryStore = ensureCanvasOpsForPanel(PRIMARY).storeApi

    const ok = await loadLayoutIntoActiveCanvas('L')

    expect(ok).toBe(true)
    expect(Object.values(targetStore.getState().nodes)).toHaveLength(1)
    expect(Object.values(primaryStore.getState().nodes)).toHaveLength(0)
  })

  it('falls back to the workspace primary canvas when no panel is active', async () => {
    setActivePanel(null)
    mockLayout(
      snapshot([{ panelType: 'terminal', origin: { x: 100, y: 100 }, size: { width: 300, height: 200 } }]),
    )
    const targetStore = ensureCanvasOpsForPanel(TARGET).storeApi
    const primaryStore = ensureCanvasOpsForPanel(PRIMARY).storeApi

    const ok = await loadLayoutIntoActiveCanvas('L')

    expect(ok).toBe(true)
    expect(Object.values(primaryStore.getState().nodes)).toHaveLength(1)
    expect(Object.values(targetStore.getState().nodes)).toHaveLength(0)
  })
})
