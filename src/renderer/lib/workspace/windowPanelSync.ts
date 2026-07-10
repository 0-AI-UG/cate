// =============================================================================
// windowPanelSync — every window reports its own panels to the main process so
// the cross-window panel union (windowPanelStore) stays current. This is the
// lightweight DISCOVERY path: a flat panel list, debounced, for ALL window types
// (main, dock, panel). It is deliberately separate from the heavier dock/panel
// session-persistence syncs (dockState, terminal scrollback, canvas snapshots)
// which run on their own cadence — so discovery is event-driven and never lags
// behind a 5s persistence tick.
//
// Wired once per window from useWindowRuntime. Debounced so a burst of store
// updates collapses into a single IPC.
// =============================================================================

import { useAppStore } from '../../stores/appStore'
import { useStatusStore } from '../../stores/statusStore'
import { selectAgentInfoByPanel } from '../../hooks/useAgentPanelInfo'
import { terminalRegistry } from '../terminal/terminalRegistry'
import { peekCanvasStoreForPanel, getAllCanvasStores } from '../../stores/canvasStore'
import { getLiveNodeDockLayout } from '../../panels/nodeDockRegistry'
import { buildColdStartCanvasChildOwners } from '../../sidebar/partitionWorkspacePanels'
import type { WindowPanelReport } from '../../../shared/types'

let cleanup: (() => void) | null = null

/** Set of panelIds (this workspace) that the owner window's scan found listening
 *  ports for. Ports are keyed by ptyId in the status store; translate via the
 *  terminalRegistry so the report keys by panelId like everything else. */
function panelsWithPorts(workspaceId: string): Set<string> {
  const ws = useStatusStore.getState().workspaces[workspaceId]
  const out = new Set<string>()
  if (!ws) return out
  for (const [ptyId, terminal] of Object.entries(ws.terminals)) {
    const ports = terminal.listeningPorts
    if (!ports.length) continue
    const pid = terminalRegistry.panelIdForPty(ptyId)
    if (pid) out.add(pid)
  }
  return out
}

/** Cheap signature over just the report-relevant status slice (agent state/name
 *  + which panels have ports), so a 1s activity poll that didn't change any of
 *  those doesn't trigger a needless re-report (and a canvas-map rebuild). */
function statusSignature(): string {
  const parts: string[] = []
  for (const [wsId, ws] of Object.entries(useStatusStore.getState().workspaces)) {
    for (const [id, terminal] of Object.entries(ws.terminals)) {
      const name = terminal.agentPresent ? terminal.agentName ?? '' : ''
      parts.push(`${wsId}:${id}:${terminal.agentState}:${name}`)
      if (terminal.listeningPorts.length) parts.push(`${wsId}:p:${id}`)
    }
  }
  return parts.sort().join('|')
}

/** Build the panel id → parent canvas panel id map for one workspace by walking
 *  each mounted canvas store's nodes. Reuses the same pure ownership logic
 *  (buildColdStartCanvasChildOwners) and the same per-node layout resolution
 *  (getLiveNodeDockLayout, falling back to the canvas store's raw projection)
 *  that useWorkspaceCanvasChildOwners uses for the in-window tree — so the
 *  overview's "Other windows" section and the local tree can't disagree about
 *  which canvas hosts a panel. Reading the raw projection alone missed any panel
 *  living in a node's mini-dock. Canvases that
 *  aren't mounted are skipped (their children report as top-level, matching how
 *  the overview already treats not-yet-loaded canvases). */
function canvasChildMap(panels: Record<string, { id: string; type: string }>): Map<string, string> {
  const snapshots = []
  for (const p of Object.values(panels)) {
    if (p.type !== 'canvas') continue
    const store = peekCanvasStoreForPanel(p.id)
    if (!store) continue
    snapshots.push({
      canvasPanelId: p.id,
      nodes: Object.values(store.getState().nodes).map((node) => {
        const live = getLiveNodeDockLayout(p.id, node.id)
        return { dockLayout: live !== undefined ? live : node.dockLayout }
      }),
    })
  }
  return buildColdStartCanvasChildOwners(snapshots)
}

export function setupWindowPanelSync(): () => void {
  if (cleanup) return cleanup

  let timer: ReturnType<typeof setTimeout> | null = null

  const send = (): void => {
    const report: WindowPanelReport[] = []
    const status = useStatusStore.getState()
    for (const ws of useAppStore.getState().workspaces) {
      const childToCanvas = canvasChildMap(ws.panels)
      // Agent state/name + ports are stamped HERE (by the owner window) because
      // the activity scan is only delivered to a panel's owner — other windows
      // never see it. Riding it on the union is the only way the overview's
      // "Other windows" rows can show the same shimmer/await/port dot as local
      // rows.
      const agentInfo = selectAgentInfoByPanel(status, ws.id)
      const withPorts = panelsWithPorts(ws.id)
      for (const p of Object.values(ws.panels)) {
        report.push({
          panelId: p.id,
          type: p.type,
          title: p.title,
          workspaceId: ws.id,
          parentCanvasId: childToCanvas.get(p.id),
          worktreeId: p.worktreeId,
          agentState: agentInfo[p.id]?.state,
          agentName: agentInfo[p.id]?.name ?? null,
          hasPorts: withPorts.has(p.id),
        })
      }
    }
    window.electronAPI.reportWindowPanels?.(report).catch(() => { /* best-effort */ })
  }

  const schedule = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(send, 200)
  }

  // parentCanvasId is derived from the canvas stores, NOT the appStore: moving a
  // panel onto/off a canvas (addNode / removeNode — e.g. dragging a dock tab onto
  // it) mutates a canvas store while ws.panels is unchanged, so an appStore-only
  // subscription would leave the report stale and the moved panel keeps reporting
  // as top-level (the overview then renders it at base level, not nested). So
  // subscribe to every canvas store too, exactly as useWorkspaceCanvasChildOwners
  // does. The set is kept current by a cheap identity diff on each appStore change
  // (creating/removing a canvas panel always touches the appStore), so unchanged
  // stores keep their subscription instead of churning every tick.
  type CanvasStoreRef = ReturnType<typeof getAllCanvasStores>[number]
  const canvasSubs = new Map<CanvasStoreRef, () => void>()
  const syncCanvasSubscriptions = (): void => {
    const live = new Set(getAllCanvasStores())
    for (const [store, unsub] of canvasSubs) {
      if (!live.has(store)) { unsub(); canvasSubs.delete(store) }
    }
    for (const store of live) {
      if (!canvasSubs.has(store)) canvasSubs.set(store, store.subscribe(schedule))
    }
  }

  send() // initial report so other windows learn this window's panels promptly
  const unsubscribeApp = useAppStore.subscribe(() => {
    syncCanvasSubscriptions()
    schedule()
  })
  syncCanvasSubscriptions()

  // Re-report when agent state / ports change so detached rows track the owner's
  // live activity. Gated on a signature of just that slice: the status store also
  // churns on every 1s activity poll (terminalActivity/cwd) that the report
  // ignores, and an ungated subscription would rebuild the canvas map each tick.
  let lastStatusSig = statusSignature()
  const unsubscribeStatus = useStatusStore.subscribe(() => {
    const sig = statusSignature()
    if (sig === lastStatusSig) return
    lastStatusSig = sig
    schedule()
  })

  cleanup = () => {
    unsubscribeApp()
    unsubscribeStatus()
    for (const unsub of canvasSubs.values()) unsub()
    canvasSubs.clear()
    if (timer) clearTimeout(timer)
    cleanup = null
  }
  return cleanup
}
