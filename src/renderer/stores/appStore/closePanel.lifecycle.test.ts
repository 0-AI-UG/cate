// =============================================================================
// closePanel lifecycle — behavioral tests for THE single disposal path for
// panel records and PTYs (appStore/panelSlice.ts closePanel, plus the helpers
// it rides on). selectionSlice.delete.test.ts mocks closePanel; this suite
// exercises the real thing end-to-end through real store actions.
//
// Faked boundary: lib/terminal/terminalRegistry. The fake reproduces the real
// registry's semantics (terminalLifecycle.ts): a window-global entry map keyed
// by panelId; dispose() deletes the entry FIRST (so re-entrant calls are
// no-ops) and only then kills the PTY; release() drops the entry WITHOUT
// killing the PTY (cross-window transfer). `ptyKill` is the spy at the actual
// IPC boundary — a call means a real shell process would have died.
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Hoisted fakes (vi.mock factories run before imports)
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => {
  interface FakeEntry {
    ptyId: string
    workspaceId: string
  }
  const entries = new Map<string, FakeEntry>()
  const ptyKill = vi.fn((_ptyId: string) => {})
  const disposeSpy = vi.fn()
  const releaseSpy = vi.fn()
  return { entries, ptyKill, disposeSpy, releaseSpy }
})

vi.mock('../../lib/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
}))

// Stateful fake mirroring terminalLifecycle.ts dispose/release/disposeWorkspace.
vi.mock('../../lib/terminal/terminalRegistry', () => ({
  terminalRegistry: {
    dispose: (panelId: string) => {
      h.disposeSpy(panelId)
      const entry = h.entries.get(panelId)
      if (!entry) return // real dispose() no-ops on a missing entry
      h.entries.delete(panelId) // removed from registry BEFORE the kill, like the real one
      h.ptyKill(entry.ptyId)
    },
    release: (panelId: string) => {
      h.releaseSpy(panelId)
      h.entries.delete(panelId) // PTY keeps running — no kill
    },
    disposeWorkspace: (workspaceId: string) => {
      for (const [panelId, entry] of [...h.entries]) {
        if (entry.workspaceId === workspaceId) {
          h.entries.delete(panelId)
          h.ptyKill(entry.ptyId)
        }
      }
    },
    has: (panelId: string) => h.entries.has(panelId),
    getEntry: (panelId: string) => h.entries.get(panelId),
  },
}))

// Agent pi sessions are out of scope here (they have no PTY); stub the module
// so importing the appStore graph doesn't pull in the agent store.
vi.mock('../../../agent/renderer/agentSessionRegistry', () => ({
  disposeAgentPanel: vi.fn(),
  getAgentPanelSession: vi.fn(),
  saveAgentPanelSession: vi.fn(),
}))

// Minimal electronAPI so the fire-and-forget workspace sync calls resolve.
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
    agentDispose: vi.fn(async () => undefined),
  }
})

import { useAppStore } from './index'
import {
  getOrCreateCanvasStoreForPanel,
  peekCanvasStoreForPanel,
} from '../canvasStore'
import { removePanelFromWindow } from '../../lib/panels/removePanelFromWindow'
import { setActivePanel, getActivePanelId } from '../../lib/activePanel'
import type { DockLayoutNode, PanelState } from '../../../shared/types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let ptySeq = 0

/** Simulate what TerminalPanel's mount does: register a live PTY-backed entry
 *  for the panel in the (faked) terminal registry. */
function spawnPty(panelId: string, workspaceId: string): string {
  const ptyId = `pty-${++ptySeq}`
  h.entries.set(panelId, { ptyId, workspaceId })
  return ptyId
}

function panelsOf(workspaceId: string): Record<string, PanelState> {
  return useAppStore.getState().workspaces.find((w) => w.id === workspaceId)?.panels ?? {}
}

function tabs(panelIds: string[]): DockLayoutNode {
  return { type: 'tabs', id: `stack-${panelIds.join('-')}`, panelIds, activeIndex: 0 }
}

/** Fresh workspace with its center canvas, as the shell would set it up. */
function makeWorkspace(suffix: string): { wsId: string; canvasId: string } {
  const wsId = useAppStore.getState().addWorkspace(`WS-${suffix}`, `/tmp/${suffix}`, `ws-${suffix}`)
  const canvasId = useAppStore.getState().createCanvas(wsId)
  return { wsId, canvasId }
}

let testSeq = 0

beforeEach(() => {
  // Tear down workspaces from the previous test (removeWorkspace mints one
  // fresh empty replacement when the last one goes — that's by design).
  for (const w of [...useAppStore.getState().workspaces]) {
    useAppStore.getState().removeWorkspace(w.id)
  }
  h.entries.clear()
  h.ptyKill.mockClear()
  h.ptyKill.mockImplementation(() => {})
  h.disposeSpy.mockClear()
  h.releaseSpy.mockClear()
  setActivePanel(null)
  testSeq += 1
})

// ---------------------------------------------------------------------------
// 1. Happy path
// ---------------------------------------------------------------------------

describe('closePanel — happy path', () => {
  it('closing a terminal removes its record, kills its PTY exactly once, and removes its (emptied) canvas node', () => {
    const { wsId, canvasId } = makeWorkspace(`hp-${testSeq}`)
    const termId = useAppStore.getState().createTerminal(wsId, undefined, { x: 10, y: 10 })
    const ptyId = spawnPty(termId, wsId)

    // Sanity: record exists and the panel landed as a node on the canvas.
    expect(panelsOf(wsId)[termId]?.type).toBe('terminal')
    const canvasStore = getOrCreateCanvasStoreForPanel(canvasId)
    const nodeId = canvasStore.getState().nodeForPanel(termId)
    expect(nodeId).toBeTruthy()
    // The interactive close path (DockTabStack tab close) first undocks the
    // panel from the node's mini-dock; emulate that emptied state here (no
    // live node dock store is mounted headlessly, so clear the projection).
    canvasStore.getState().setNodeDockLayout(nodeId!, null)
    setActivePanel(termId)

    useAppStore.getState().closePanel(wsId, termId)

    // Record gone, PTY killed exactly once at the boundary.
    expect(panelsOf(wsId)[termId]).toBeUndefined()
    expect(h.ptyKill).toHaveBeenCalledTimes(1)
    expect(h.ptyKill).toHaveBeenCalledWith(ptyId)
    expect(h.entries.has(termId)).toBe(false)

    // The canvas node is on its way out (removeNode marks it 'exiting'; the UI
    // finalizes after the animation) and no longer resolves for the panel after
    // finalize. Either way it must not be a live idle node anymore.
    const node = nodeId ? canvasStore.getState().nodes[nodeId] : undefined
    expect(node === undefined || node.animationState === 'exiting').toBe(true)

    // Closed panel no longer reads as the active panel.
    expect(getActivePanelId()).toBeNull()

    // The canvas panel itself is untouched.
    expect(panelsOf(wsId)[canvasId]?.type).toBe('canvas')
  })

  it('headless close (cateAgentTools/runAction path) leaves the canvas node behind with a stale panelId (BUG?)', () => {
    const { wsId, canvasId } = makeWorkspace(`ghost-${testSeq}`)
    const termId = useAppStore.getState().createTerminal(wsId, undefined, { x: 10, y: 10 })
    const ptyId = spawnPty(termId, wsId)
    const canvasStore = getOrCreateCanvasStoreForPanel(canvasId)
    const nodeId = canvasStore.getState().nodeForPanel(termId)!

    // Call closePanel directly, the way cateAgentTools close_terminal and the
    // runAction 'closePanel' shortcut do — with the node's seeded mini-dock
    // layout (every addNode seeds dockLayout = [its own panel]) untouched.
    useAppStore.getState().closePanel(wsId, termId)

    // Disposal and record removal still happen correctly...
    expect(panelsOf(wsId)[termId]).toBeUndefined()
    expect(h.ptyKill).toHaveBeenCalledTimes(1)
    expect(h.ptyKill).toHaveBeenCalledWith(ptyId)

    // BUG?: ...but removeNodeForPanel early-returns whenever the node's dock
    // layout still lists ANY panel — and the seeded layout always lists the
    // panel being closed. So unless a UI layer emptied the node's mini-dock
    // first (the DockTabStack close path) or removes the node itself
    // (deleteSelection, CanvasNode close button), the node survives as a ghost
    // pointing at a deleted panel record. Headless callers (cateAgentTools
    // close_terminal, runAction closePanel on a culled/unmounted node) hit
    // exactly this.
    const node = canvasStore.getState().nodes[nodeId]
    expect(node).toBeDefined() // ghost node
    expect(node.animationState).not.toBe('exiting')
    expect(node.panelId).toBe(termId) // stale reference to a deleted record
  })

  it('closing an editor removes its record without touching any PTY', () => {
    const { wsId } = makeWorkspace(`hp2-${testSeq}`)
    const termId = useAppStore.getState().createTerminal(wsId, undefined, { x: 0, y: 0 })
    spawnPty(termId, wsId)
    const editorId = useAppStore.getState().createEditor(wsId, '/tmp/file.ts', { x: 300, y: 0 })

    useAppStore.getState().closePanel(wsId, editorId)

    expect(panelsOf(wsId)[editorId]).toBeUndefined()
    // The terminal's PTY is untouched by the editor close.
    expect(h.ptyKill).not.toHaveBeenCalled()
    expect(h.entries.has(termId)).toBe(true)
    expect(panelsOf(wsId)[termId]).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// 2. Closing a canvas panel with children
// ---------------------------------------------------------------------------

describe('closePanel — canvas with children', () => {
  it('recursively disposes child node panels AND mini-dock tab panels, then releases the canvas store', () => {
    const { wsId } = makeWorkspace(`cv-${testSeq}`)
    const canvas2 = useAppStore.getState().createCanvas(wsId)

    // Two children placed on the secondary canvas via the pinned-canvas path.
    const childTerm = useAppStore.getState().createTerminal(
      wsId, undefined, undefined,
      { target: 'canvas', canvasPanelId: canvas2, position: { x: 0, y: 0 } },
    )
    const childEditor = useAppStore.getState().createEditor(
      wsId, '/tmp/x.ts', undefined,
      { target: 'canvas', canvasPanelId: canvas2, position: { x: 400, y: 0 } },
    )
    const childPty = spawnPty(childTerm, wsId)

    // A second terminal living only as a TAB in the child node's mini-dock
    // (no canvas node of its own) — closePanel must find it via the node's
    // dock layout.
    const dockChild = `dock-child-${testSeq}`
    useAppStore.getState().addPanel(wsId, { id: dockChild, type: 'terminal', title: 'T-tab', isDirty: false })
    const dockChildPty = spawnPty(dockChild, wsId)
    const canvas2Store = getOrCreateCanvasStoreForPanel(canvas2)
    const childNodeId = canvas2Store.getState().nodeForPanel(childTerm)!
    canvas2Store.getState().setNodeDockLayout(childNodeId, tabs([childTerm, dockChild]))

    useAppStore.getState().closePanel(wsId, canvas2)

    // All child records gone, both terminal PTYs killed exactly once each.
    expect(panelsOf(wsId)[canvas2]).toBeUndefined()
    expect(panelsOf(wsId)[childTerm]).toBeUndefined()
    expect(panelsOf(wsId)[childEditor]).toBeUndefined()
    expect(panelsOf(wsId)[dockChild]).toBeUndefined()
    expect(h.ptyKill).toHaveBeenCalledTimes(2)
    expect(h.ptyKill).toHaveBeenCalledWith(childPty)
    expect(h.ptyKill).toHaveBeenCalledWith(dockChildPty)

    // The per-panel canvas store was released.
    expect(peekCanvasStoreForPanel(canvas2)).toBeUndefined()
  })

  it('canvas-on-canvas is refused at the data layer, so one-level child recursion is exhaustive', () => {
    const { wsId } = makeWorkspace(`nest-${testSeq}`)
    const parentCanvas = useAppStore.getState().createCanvas(wsId)

    // closePanel recurses exactly ONE level into a closing canvas's children.
    // That is sufficient only because a canvas node can never host another
    // canvas: addNode refuses panelType 'canvas' outright (returns '' and adds
    // nothing), so a grandchild canvas — the case that would need deeper
    // recursion — is structurally impossible.
    const parentStore = getOrCreateCanvasStoreForPanel(parentCanvas)
    const refused = parentStore.getState()
      .addNode(`nested-canvas-${testSeq}`, 'canvas', { x: 0, y: 0 }, { width: 600, height: 400 })
    expect(refused).toBe('')
    expect(Object.keys(parentStore.getState().nodes)).toEqual([])

    // And a closing canvas with a normal child still cleans up that child.
    const childTerm = useAppStore.getState().createTerminal(
      wsId, undefined, undefined,
      { target: 'canvas', canvasPanelId: parentCanvas, position: { x: 0, y: 0 } },
    )
    const childPty = spawnPty(childTerm, wsId)

    useAppStore.getState().closePanel(wsId, parentCanvas)

    expect(panelsOf(wsId)[parentCanvas]).toBeUndefined()
    expect(panelsOf(wsId)[childTerm]).toBeUndefined()
    expect(h.ptyKill).toHaveBeenCalledTimes(1)
    expect(h.ptyKill).toHaveBeenCalledWith(childPty)
  })
})

// ---------------------------------------------------------------------------
// 3. Panels owned by a detached window
// ---------------------------------------------------------------------------

describe('closePanel — detached-window interactions', () => {
  it('a transfer (detach) releases the xterm but never kills the PTY, and drops the record', () => {
    const { wsId } = makeWorkspace(`det-${testSeq}`)
    const termId = useAppStore.getState().createTerminal(wsId, undefined, { x: 0, y: 0 })
    spawnPty(termId, wsId)

    // What the detach/cross-window-drop path runs in the source window.
    removePanelFromWindow(wsId, termId, 'terminal', 'transfer')

    expect(h.releaseSpy).toHaveBeenCalledWith(termId)
    expect(h.ptyKill).not.toHaveBeenCalled() // PTY survives the move
    expect(panelsOf(wsId)[termId]).toBeUndefined() // record now lives in the other window
  })

  it('closePanel on an already-transferred panel is inert: it cannot reach the moved PTY', () => {
    const { wsId } = makeWorkspace(`det2-${testSeq}`)
    const termId = useAppStore.getState().createTerminal(wsId, undefined, { x: 0, y: 0 })
    spawnPty(termId, wsId)
    removePanelFromWindow(wsId, termId, 'terminal', 'transfer')
    h.disposeSpy.mockClear()

    // E.g. a stale UI action referencing the now-detached panel. Note the
    // close-vs-transfer decision is encapsulated in teardownPanelContent and
    // the registry entry was already released, so dispose() finds nothing —
    // the detached window's live PTY cannot be killed from here. Closing a
    // detached panel for real routes through that window's own close handler
    // (DockWindowShell → removePanelFromWindow 'close').
    expect(() => useAppStore.getState().closePanel(wsId, termId)).not.toThrow()
    expect(h.disposeSpy).toHaveBeenCalledWith(termId) // probe happens...
    expect(h.ptyKill).not.toHaveBeenCalled() // ...but nothing to kill
  })

  it("closes a record-only panel (placement 'none', e.g. a mini-dock owner placed it privately)", () => {
    const { wsId } = makeWorkspace(`none-${testSeq}`)
    const termId = useAppStore.getState().createTerminal(wsId, undefined, undefined, { target: 'none' })
    const ptyId = spawnPty(termId, wsId)
    expect(panelsOf(wsId)[termId]).toBeDefined()

    // Not in the dock tree, not on any canvas — resolvePanelLocation finds
    // nothing, but disposal and record removal must still happen.
    useAppStore.getState().closePanel(wsId, termId)

    expect(panelsOf(wsId)[termId]).toBeUndefined()
    expect(h.ptyKill).toHaveBeenCalledTimes(1)
    expect(h.ptyKill).toHaveBeenCalledWith(ptyId)
  })
})

// ---------------------------------------------------------------------------
// 4. Cross-workspace isolation
// ---------------------------------------------------------------------------

describe('closePanel — workspace isolation', () => {
  it("closing a panel in workspace A never touches workspace B's panels or PTYs", () => {
    const a = makeWorkspace(`iso-a-${testSeq}`)
    const b = makeWorkspace(`iso-b-${testSeq}`)
    const termA = useAppStore.getState().createTerminal(a.wsId, undefined, { x: 0, y: 0 })
    const termB = useAppStore.getState().createTerminal(b.wsId, undefined, { x: 0, y: 0 })
    const ptyA = spawnPty(termA, a.wsId)
    const ptyB = spawnPty(termB, b.wsId)

    useAppStore.getState().closePanel(a.wsId, termA)

    expect(h.ptyKill).toHaveBeenCalledTimes(1)
    expect(h.ptyKill).toHaveBeenCalledWith(ptyA)
    expect(h.ptyKill).not.toHaveBeenCalledWith(ptyB)
    expect(panelsOf(b.wsId)[termB]).toBeDefined()
    expect(h.entries.has(termB)).toBe(true)
    // B's canvas node is untouched.
    expect(getOrCreateCanvasStoreForPanel(b.canvasId).getState().nodeForPanel(termB)).toBeTruthy()
  })

  it("duplicate panel ids across workspaces: the record removal is scoped to A, but the registry is window-global", () => {
    const a = makeWorkspace(`dup-a-${testSeq}`)
    const b = makeWorkspace(`dup-b-${testSeq}`)
    const dupId = `dup-term-${testSeq}`
    useAppStore.getState().addPanel(a.wsId, { id: dupId, type: 'terminal', title: 'Dup A', isDirty: false })
    useAppStore.getState().addPanel(b.wsId, { id: dupId, type: 'terminal', title: 'Dup B', isDirty: false })
    // The registry is keyed by panelId per WINDOW, so two same-id panels can
    // only ever own ONE entry — ids are assumed globally unique (generateId).
    // Register the entry as B's live terminal to expose the seam.
    const ptyB = spawnPty(dupId, b.wsId)

    useAppStore.getState().closePanel(a.wsId, dupId)

    // The store-level removal is correctly scoped: only A's record is gone.
    expect(panelsOf(a.wsId)[dupId]).toBeUndefined()
    expect(panelsOf(b.wsId)[dupId]).toBeDefined()

    // BUG?: the registry teardown is NOT scoped — dispose(panelId) is keyed by
    // panel id alone, so closing A's copy killed the PTY registered for B's
    // same-id panel. Harmless as long as generateId keeps ids unique per
    // window, but any id collision (hand-edited session.json, forced restore
    // ids) silently kills the other workspace's terminal.
    expect(h.ptyKill).toHaveBeenCalledWith(ptyB)
  })
})

// ---------------------------------------------------------------------------
// 5. Unhappy / edge cases
// ---------------------------------------------------------------------------

describe('closePanel — unhappy paths', () => {
  it('unknown panel id: no throw, no state damage, no PTY killed', () => {
    const { wsId } = makeWorkspace(`unk-${testSeq}`)
    const termId = useAppStore.getState().createTerminal(wsId, undefined, { x: 0, y: 0 })
    spawnPty(termId, wsId)
    const before = JSON.parse(JSON.stringify(useAppStore.getState().workspaces))

    expect(() => useAppStore.getState().closePanel(wsId, 'no-such-panel')).not.toThrow()

    expect(JSON.parse(JSON.stringify(useAppStore.getState().workspaces))).toEqual(before)
    expect(h.ptyKill).not.toHaveBeenCalled()
    expect(h.entries.has(termId)).toBe(true)
  })

  it('double close: the second call is a no-op and the PTY is killed exactly once', () => {
    const { wsId } = makeWorkspace(`dbl-${testSeq}`)
    const termId = useAppStore.getState().createTerminal(wsId, undefined, { x: 0, y: 0 })
    spawnPty(termId, wsId)

    useAppStore.getState().closePanel(wsId, termId)
    expect(() => useAppStore.getState().closePanel(wsId, termId)).not.toThrow()

    expect(h.ptyKill).toHaveBeenCalledTimes(1)
    expect(panelsOf(wsId)[termId]).toBeUndefined()
  })

  it('closing the last panel leaves the workspace coherent and still able to create panels', () => {
    const { wsId, canvasId } = makeWorkspace(`last-${testSeq}`)
    const termId = useAppStore.getState().createTerminal(wsId, undefined, { x: 0, y: 0 })
    spawnPty(termId, wsId)

    useAppStore.getState().closePanel(wsId, termId)
    useAppStore.getState().closePanel(wsId, canvasId) // close the center canvas too

    const ws = useAppStore.getState().workspaces.find((w) => w.id === wsId)
    expect(ws).toBeDefined() // workspace itself survives
    expect(Object.keys(ws!.panels)).toEqual([]) // truly empty, no zombie records
    expect(useAppStore.getState().selectedWorkspaceId).toBeTruthy()

    // The store still functions: a new create lands somewhere (with no canvas
    // left, placePanel falls back to the center dock zone) and is recorded.
    const newTerm = useAppStore.getState().createTerminal(wsId, undefined, undefined)
    expect(newTerm).toBeTruthy()
    expect(panelsOf(wsId)[newTerm]?.type).toBe('terminal')
  })
})

// ---------------------------------------------------------------------------
// 6. Disposal failure
// ---------------------------------------------------------------------------

describe('closePanel — disposal failure', () => {
  it('a synchronous teardown throw aborts the close and leaves a zombie panel record (BUG?)', () => {
    const { wsId } = makeWorkspace(`fail-${testSeq}`)
    const termId = useAppStore.getState().createTerminal(wsId, undefined, { x: 0, y: 0 })
    spawnPty(termId, wsId)

    // The real dispose() catches PTY-kill IPC rejections (.catch), but its
    // xterm teardown (cleanupListeners loop, terminal.dispose) is NOT guarded
    // — a synchronous throw there escapes teardownPanelContent.
    h.ptyKill.mockImplementationOnce(() => {
      throw new Error('xterm teardown exploded')
    })

    // BUG?: closePanel runs teardownPanelContent FIRST and without try/catch,
    // so a sync teardown failure aborts the whole close: the panel record
    // stays in workspace.panels and the dock/canvas placement is never
    // removed. The user sees a panel that refused to close; session.json
    // keeps persisting it. (The registry entry itself is already gone — real
    // dispose deletes it before tearing down — so a RETRY close then succeeds
    // in dropping the record, which is the only recovery path.)
    expect(() => useAppStore.getState().closePanel(wsId, termId)).toThrow('xterm teardown exploded')
    expect(panelsOf(wsId)[termId]).toBeDefined() // zombie record

    // Retry: entry already consumed, teardown no-ops, record finally removed.
    expect(() => useAppStore.getState().closePanel(wsId, termId)).not.toThrow()
    expect(panelsOf(wsId)[termId]).toBeUndefined()
  })

  it('an async PTY-kill IPC rejection does not block the close (real dispose swallows it)', () => {
    const { wsId } = makeWorkspace(`rej-${testSeq}`)
    const termId = useAppStore.getState().createTerminal(wsId, undefined, { x: 0, y: 0 })
    spawnPty(termId, wsId)

    // Model the real path: terminalKill() rejects, dispose catches and logs —
    // from the caller's perspective the kill "succeeded" synchronously.
    h.ptyKill.mockImplementationOnce((ptyId: string) => {
      void Promise.reject(new Error(`kill ${ptyId} failed`)).catch(() => { /* logged */ })
    })

    expect(() => useAppStore.getState().closePanel(wsId, termId)).not.toThrow()
    expect(panelsOf(wsId)[termId]).toBeUndefined()
    expect(h.entries.has(termId)).toBe(false)
  })
})
