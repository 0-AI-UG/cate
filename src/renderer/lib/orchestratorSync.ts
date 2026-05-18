// =============================================================================
// orchestratorSync — pushes a snapshot of this window's terminals + canvas
// connections to the main-process orchestrator whenever anything relevant
// changes.
//
// The orchestrator (cate CLI) needs to know:
//   - which terminals exist on the canvas
//   - their display names (PanelState.title)
//   - their ptyId (filled in once the PTY spawns)
//   - which canvas node hosts each one
//   - the connection graph between canvas nodes
//
// We subscribe to appStore (titles, terminal panels) and canvasStore (nodes,
// connections) and debounce-push a full snapshot on changes.
// =============================================================================

import { useAppStore } from '../stores/appStore'
import { useCanvasStore } from '../stores/canvasStore'
import { terminalRegistry } from './terminalRegistry'

interface SnapTerminal {
  ptyId: string | null
  panelId: string
  nodeId: string | null
  name: string
}

interface SnapPortal {
  panelId: string
  nodeId: string | null
  name: string
}

interface Snapshot {
  terminals: SnapTerminal[]
  portals: SnapPortal[]
  connections: Array<{ from: string; to: string }>
}

let lastJson = ''
let pushTimer: ReturnType<typeof setTimeout> | null = null

function buildSnapshot(): Snapshot {
  const app = useAppStore.getState()
  const canvas = useCanvasStore.getState()
  const wsId = app.selectedWorkspaceId
  const ws = app.workspaces.find((w) => w.id === wsId)
  if (!ws) return { terminals: [], portals: [], connections: [] }

  // Map panelId -> the canvas node that hosts it (if any). One node can host
  // a tab stack with several panels; we map every member panel to the node.
  const panelToNode = new Map<string, string>()
  for (const node of Object.values(canvas.nodes)) {
    const layout = node.dockLayout
    const collectPanelIds = (n: any): void => {
      if (!n) return
      if (n.type === 'tabs' && Array.isArray(n.panelIds)) {
        for (const pid of n.panelIds) panelToNode.set(pid, node.id)
      } else if (Array.isArray(n.children)) {
        for (const c of n.children) collectPanelIds(c)
      }
    }
    if (layout) collectPanelIds(layout)
    // Fallback: legacy single-panel nodes use node.panelId.
    if ((node as any).panelId) panelToNode.set((node as any).panelId, node.id)
  }

  const terminals: SnapTerminal[] = []
  const portals: SnapPortal[] = []
  for (const panel of Object.values(ws.panels)) {
    if (panel.type === 'terminal') {
      const entry = terminalRegistry.getEntry(panel.id)
      terminals.push({
        ptyId: entry?.ptyId || null,
        panelId: panel.id,
        nodeId: panelToNode.get(panel.id) ?? null,
        name: panel.title,
      })
    } else if (panel.type === 'browser') {
      portals.push({
        panelId: panel.id,
        nodeId: panelToNode.get(panel.id) ?? null,
        name: panel.title,
      })
    }
  }

  const connections: Snapshot['connections'] = []
  // Phase B will populate canvas.connections; Phase A keeps an empty array.
  const conns = (canvas as any).connections as Record<string, { from: string; to: string }> | undefined
  if (conns) {
    for (const c of Object.values(conns)) {
      connections.push({ from: c.from, to: c.to })
    }
  }

  return { terminals, portals, connections }
}

function schedulePush(): void {
  if (pushTimer) return
  pushTimer = setTimeout(() => {
    pushTimer = null
    flushPushNow()
  }, 100)
}

/** Force an immediate sync push — bypass the 100ms debounce. Called after any
 *  orchestrator-driven mutation (recruit, connect, note create, etc.) so the
 *  CLI's NEXT command sees the updated graph instead of racing the debounce. */
export async function flushOrchestratorSync(): Promise<void> {
  if (pushTimer) {
    clearTimeout(pushTimer)
    pushTimer = null
  }
  await flushPushNow()
}

async function flushPushNow(): Promise<void> {
  const snap = buildSnapshot()
  const json = JSON.stringify(snap)
  if (json === lastJson) return
  lastJson = json
  const api = (window as any).electronAPI
  if (!api || typeof api.orchSyncRegistry !== 'function') return
  try { await api.orchSyncRegistry(snap) } catch { /* main may not be ready yet */ }
}

let started = false
export function startOrchestratorSync(): void {
  if (started) return
  started = true

  // Push initial snapshot once the renderer has bootstrapped.
  schedulePush()

  // Push on every store change. Zustand fires the subscription on any state
  // mutation; we debounce so a burst of small updates collapses to one push.
  useAppStore.subscribe(() => schedulePush())
  useCanvasStore.subscribe(() => schedulePush())

  // ptyIds fill in asynchronously after terminalCreate resolves. Polling at
  // 1Hz catches that without coupling to terminalRegistry's internals.
  setInterval(() => schedulePush(), 1000)

  // Listen for "ask in flight" events from main and reflect them in
  // canvasStore so the matching connection wire animates brighter / faster.
  const api = (window as any).electronAPI
  if (api?.onOrchInflight) {
    api.onOrchInflight((payload: { fromNodeId: string; toNodeId: string; active: boolean }) => {
      const state = useCanvasStore.getState()
      let matchId: string | null = null
      for (const c of Object.values(state.connections)) {
        if ((c.from === payload.fromNodeId && c.to === payload.toNodeId) ||
            (c.from === payload.toNodeId && c.to === payload.fromNodeId)) {
          matchId = c.id
          break
        }
      }
      if (matchId) state.setInflightConnection(matchId, payload.active)
    })
  }
}
