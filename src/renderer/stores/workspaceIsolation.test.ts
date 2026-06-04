// =============================================================================
// Per-workspace isolation regression tests. Each workspace owns its own dock +
// canvas stores; switching swaps which stores the shell reads and restore writes
// into a workspace addressed by id. These tests pin the invariant that content
// can never bleed from one workspace into another — the bug this architecture
// was built to make structurally impossible.
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../lib/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
}))
vi.mock('../lib/terminal/terminalRegistry', () => ({
  terminalRegistry: {
    dispose: vi.fn(),
    disposeWorkspace: vi.fn(),
    getEntry: vi.fn(),
    has: vi.fn(() => false),
  },
}))

// Minimal electronAPI so workspace:create / update sync calls resolve.
beforeEach(() => {
  const g = globalThis as unknown as { window?: { electronAPI?: unknown } }
  g.window = g.window ?? {}
  g.window.electronAPI = {
    workspaceCreate: vi.fn(async (input: { id?: string; name?: string; rootPath?: string }) => ({
      ok: true,
      workspace: {
        id: input.id ?? 'gen',
        name: input.name ?? 'Workspace',
        color: '',
        rootPath: input.rootPath ?? '',
      },
    })),
    workspaceUpdate: vi.fn(async () => ({ ok: true, workspace: {} })),
    workspaceRemove: vi.fn(async () => ({ ok: true })),
    recentProjectsAdd: vi.fn(),
    recentProjectsRemove: vi.fn(async () => undefined),
  }
})

import { useAppStore, getWorkspaceCanvasStore } from './appStore'
import { getWorkspaceDockStore, getOrCreateWorkspaceDockStore } from './workspaceStores'
import { restoreSession } from '../lib/workspace/session'
import type { SessionSnapshot } from '../../shared/types'

/** A minimal one-editor snapshot whose canvas lives in the center dock zone. */
function makeSnapshot(canvasPanelId: string, rootPath: string): SessionSnapshot {
  return {
    workspaceName: 'restored',
    rootPath,
    zoomLevel: 1,
    viewportOffset: { x: 0, y: 0 },
    nodes: [
      {
        panelId: 'ed-1',
        panelType: 'editor',
        title: 'file.ts',
        origin: { x: 10, y: 10 },
        size: { width: 200, height: 150 },
        filePath: `${rootPath}/file.ts`,
      },
    ],
    dockPanels: {
      [canvasPanelId]: { id: canvasPanelId, type: 'canvas', title: 'Canvas', isDirty: false },
    },
    dockState: {
      zones: {
        left: { position: 'left', visible: false, size: 260, layout: null },
        right: { position: 'right', visible: false, size: 260, layout: null },
        bottom: { position: 'bottom', visible: false, size: 240, layout: null },
        center: {
          position: 'center',
          visible: true,
          size: 0,
          layout: { type: 'tabs', id: 'stack-1', panelIds: [canvasPanelId], activeIndex: 0 },
        },
      },
      locations: {},
    },
  }
}

function dockPanelIds(workspaceId: string): string[] {
  const store = getWorkspaceDockStore(workspaceId)
  if (!store) return []
  const { zones } = store.getState().getSnapshot()
  const ids: string[] = []
  for (const zone of Object.values(zones)) {
    const layout = zone.layout
    if (!layout) continue
    const walk = (n: typeof layout): void => {
      if (!n) return
      if (n.type === 'tabs') ids.push(...n.panelIds)
      else n.children.forEach(walk)
    }
    walk(layout)
  }
  return ids
}

function reset() {
  // Tear down any workspaces from a previous test so each starts clean.
  for (const w of [...useAppStore.getState().workspaces]) {
    useAppStore.getState().removeWorkspace(w.id)
  }
}

describe('per-workspace dock isolation', () => {
  beforeEach(reset)

  it('gives each workspace a distinct dock store instance', () => {
    const a = useAppStore.getState().addWorkspace('A', '/tmp/a', 'ws-a')
    const b = useAppStore.getState().addWorkspace('B', '/tmp/b', 'ws-b')
    const dockA = getOrCreateWorkspaceDockStore(a)
    const dockB = getOrCreateWorkspaceDockStore(b)
    expect(dockA).not.toBe(dockB)
  })

  it("a canvas placed in one workspace does not appear in another's dock", async () => {
    const a = useAppStore.getState().addWorkspace('A', '/tmp/a', 'ws-a')
    const b = useAppStore.getState().addWorkspace('B', '/tmp/b', 'ws-b')

    const canvasA = useAppStore.getState().createCanvas(a)
    const canvasB = useAppStore.getState().createCanvas(b)

    // Each canvas panel lands only in its own workspace's dock store.
    expect(dockPanelIds(a)).toContain(canvasA)
    expect(dockPanelIds(a)).not.toContain(canvasB)
    expect(dockPanelIds(b)).toContain(canvasB)
    expect(dockPanelIds(b)).not.toContain(canvasA)
  })

  it('restoreSession into a non-selected workspace leaves the selected one untouched', async () => {
    const a = useAppStore.getState().addWorkspace('A', '/tmp/a', 'ws-a')
    const b = useAppStore.getState().addWorkspace('B', '/tmp/b', 'ws-b')

    // A is the active workspace with its own canvas; select it explicitly.
    await useAppStore.getState().selectWorkspace(a)
    const canvasA = useAppStore.getState().createCanvas(a)
    expect(useAppStore.getState().selectedWorkspaceId).toBe(a)
    const aPanelsBefore = Object.keys(useAppStore.getState().workspaces.find((w) => w.id === a)!.panels).sort()
    const aNodesBefore = Object.keys(getWorkspaceCanvasStore(a)?.getState().nodes ?? {}).length

    // Restore B's snapshot *while A is selected* — the old bug let this land in A.
    await restoreSession(makeSnapshot('cv-b', '/tmp/b'), b)

    // Selection unchanged; A's panels + canvas nodes are exactly as before.
    expect(useAppStore.getState().selectedWorkspaceId).toBe(a)
    const aPanelsAfter = Object.keys(useAppStore.getState().workspaces.find((w) => w.id === a)!.panels).sort()
    expect(aPanelsAfter).toEqual(aPanelsBefore)
    expect(Object.keys(getWorkspaceCanvasStore(a)?.getState().nodes ?? {}).length).toBe(aNodesBefore)
    expect(aPanelsAfter).toContain(canvasA)

    // B received its restored canvas + one editor node, in B's OWN stores.
    const wsB = useAppStore.getState().workspaces.find((w) => w.id === b)!
    expect(Object.values(wsB.panels).some((p) => p.type === 'canvas')).toBe(true)
    expect(Object.values(wsB.panels).some((p) => p.type === 'editor')).toBe(true)
    expect(Object.keys(getWorkspaceCanvasStore(b)?.getState().nodes ?? {}).length).toBe(1)

    // A's dock store never gained B's canvas panel.
    expect(dockPanelIds(a)).not.toContain('cv-b')
  })

  it('panels recorded on a workspace stay scoped to that workspace', () => {
    const a = useAppStore.getState().addWorkspace('A', '/tmp/a', 'ws-a')
    const b = useAppStore.getState().addWorkspace('B', '/tmp/b', 'ws-b')

    useAppStore.getState().createCanvas(a)
    useAppStore.getState().createEditor(a, '/tmp/a/file.ts')

    const wsB = useAppStore.getState().workspaces.find((w) => w.id === b)!
    // ws B's panels never include ws A's editor/canvas.
    const wsA = useAppStore.getState().workspaces.find((w) => w.id === a)!
    const aPanelIds = Object.keys(wsA.panels)
    for (const id of Object.keys(wsB.panels)) {
      expect(aPanelIds).not.toContain(id)
    }
  })
})
