// =============================================================================
// Terminal registry — main-process mirror of every Cate terminal panel.
//
// The renderer pushes a snapshot whenever titles, panels, or canvas nodes
// change. The orchestrator queries this registry to resolve `cate ask "Name"`
// to a ptyId, look up the caller's identity, list peers, etc.
//
// The renderer is the source of truth (it owns canvasStore + appStore); main
// is a downstream consumer. Snapshots are full replacements rather than diffs
// — the data is small and the simplicity is worth it.
// =============================================================================

import type { OrchTerminalInfo } from './protocol'

export interface RegistrySnapshot {
  /** Per-window terminal list. Window id is the BrowserWindow id whose renderer
   *  pushed the snapshot. Connections are scoped to the originating window. */
  windowId: number
  terminals: Array<{
    ptyId: string | null    // null if PTY hasn't been created yet (panel exists but TerminalPanel hasn't mounted)
    panelId: string
    nodeId: string | null
    name: string
  }>
  /** Browser/portal panels — used by `cate portal …` commands. */
  portals?: Array<{
    panelId: string
    nodeId: string | null
    name: string
  }>
  connections: Array<{ from: string; to: string }>  // node ids
}

interface WindowState {
  terminals: RegistrySnapshot['terminals']
  portals: NonNullable<RegistrySnapshot['portals']>
  /** Adjacency by canvas node id. */
  adjacency: Map<string, Set<string>>
}

const byWindow = new Map<number, WindowState>()

/** Drop all state for a window (called when its BrowserWindow closes). */
export function clearWindow(windowId: number): void {
  byWindow.delete(windowId)
}

export function applySnapshot(snap: RegistrySnapshot): void {
  const adjacency = new Map<string, Set<string>>()
  for (const c of snap.connections) {
    if (!adjacency.has(c.from)) adjacency.set(c.from, new Set())
    if (!adjacency.has(c.to)) adjacency.set(c.to, new Set())
    adjacency.get(c.from)!.add(c.to)
    adjacency.get(c.to)!.add(c.from)
  }
  byWindow.set(snap.windowId, {
    terminals: snap.terminals,
    portals: snap.portals ?? [],
    adjacency,
  })
}

/** Find a portal panel by display name within a specific window. */
export function findPortalByName(windowId: number, name: string): WindowState['portals'][number] | null {
  const state = byWindow.get(windowId)
  if (!state) return null
  const needle = name.trim().toLowerCase()
  return state.portals.find((p) => p.name.trim().toLowerCase() === needle) ?? null
}

/** Find a portal panel by its renderer-side panelId. Used by the popup
 *  parent-resolver to translate "I know this webContents id maps to this
 *  panelId" into the portal's current display name + node id. */
export function findPortalByPanelId(windowId: number, panelId: string): WindowState['portals'][number] | null {
  const state = byWindow.get(windowId)
  if (!state) return null
  return state.portals.find((p) => p.panelId === panelId) ?? null
}

function toInfo(t: WindowState['terminals'][number]): OrchTerminalInfo {
  return {
    ptyId: t.ptyId ?? '',
    panelId: t.panelId,
    nodeId: t.nodeId,
    name: t.name,
  }
}

/** Find the window+terminal entry that owns a given ptyId. */
export function findByPtyId(ptyId: string): { windowId: number; entry: WindowState['terminals'][number] } | null {
  for (const [windowId, state] of byWindow) {
    const entry = state.terminals.find((t) => t.ptyId === ptyId)
    if (entry) return { windowId, entry }
  }
  return null
}

/** Find a terminal by panelId within a specific window. Used by recruit to
 *  wait for a freshly-spawned panel's PTY to become known. */
export function findByPanelId(windowId: number, panelId: string): WindowState['terminals'][number] | null {
  const state = byWindow.get(windowId)
  if (!state) return null
  return state.terminals.find((t) => t.panelId === panelId) ?? null
}

/** Find a terminal by display name within a specific window. Case-insensitive,
 *  exact match (trimmed). */
export function findByName(windowId: number, name: string): WindowState['terminals'][number] | null {
  const state = byWindow.get(windowId)
  if (!state) return null
  const needle = name.trim().toLowerCase()
  return state.terminals.find((t) => t.name.trim().toLowerCase() === needle) ?? null
}

/** List all terminals in a window, optionally filtered to those connected to
 *  the given source node via the canvas graph. Returns the caller's own entry
 *  marked as self, plus peers. */
export function listForCaller(
  windowId: number,
  callerPtyId: string,
  options: { graphAware: boolean },
): { self: OrchTerminalInfo | null; peers: OrchTerminalInfo[] } {
  const state = byWindow.get(windowId)
  if (!state) return { self: null, peers: [] }

  const selfEntry = state.terminals.find((t) => t.ptyId === callerPtyId)
  const self = selfEntry ? { ...toInfo(selfEntry), self: true } : null

  let peers: OrchTerminalInfo[]
  if (options.graphAware && selfEntry?.nodeId) {
    const connected = state.adjacency.get(selfEntry.nodeId) ?? new Set()
    peers = state.terminals
      .filter((t) => t.nodeId && connected.has(t.nodeId) && t.ptyId !== callerPtyId)
      .map(toInfo)
  } else {
    peers = state.terminals.filter((t) => t.ptyId !== callerPtyId).map(toInfo)
  }
  return { self, peers }
}

/** True if the two terminals share a canvas connection (or if graphAware is
 *  off, true whenever both exist in the same window). */
export function isConnected(
  windowId: number,
  fromPtyId: string,
  toPtyId: string,
  options: { graphAware: boolean },
): boolean {
  const state = byWindow.get(windowId)
  if (!state) return false
  const from = state.terminals.find((t) => t.ptyId === fromPtyId)
  const to = state.terminals.find((t) => t.ptyId === toPtyId)
  if (!from || !to) return false
  if (!options.graphAware) return true
  if (!from.nodeId || !to.nodeId) return false
  return state.adjacency.get(from.nodeId)?.has(to.nodeId) ?? false
}

/** Return the set of node ids adjacent to a given node in the caller's window.
 *  Used by `cate connect` to check the caller's authorization to wire other
 *  panels (caller must be one of the endpoints or already adjacent to one). */
export function adjacencyFor(windowId: number, nodeId: string): Set<string> | null {
  const state = byWindow.get(windowId)
  if (!state) return null
  return state.adjacency.get(nodeId) ?? new Set<string>()
}
