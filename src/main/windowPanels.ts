// =============================================================================
// windowPanels — the cross-window panel discovery union (main process).
//
// Every window reports its own panels over WINDOW_PANELS_REPORT (a lightweight,
// event-driven list — see windowPanelSync in the renderer). This module keeps the
// latest report per window in ONE map, flattens them into a single shadow list
// (WindowPanelInfo[]), and broadcasts it to every window over WINDOW_PANELS_CHANGED
// whenever it changes. Each window projects the broadcast into windowPanelStore
// and excludes its own panels by id, so what's left is the panels that live in
// OTHER windows (surfaced by the overview + command palette).
//
// This is deliberately decoupled from the dock session-persistence sync
// (windowRegistry's setDockWindowState): it persists heavy state on its own
// cadence and no longer drives discovery, so the union never lags behind a 5s
// persistence tick.
//
// The dependency is one-directional: this module reads windowRegistry's public
// getters and subscribes to onWindowClosed; windowRegistry never imports it.
// =============================================================================

import type { WindowPanelInfo, WindowPanelReport } from '../shared/types'
import { WINDOW_PANELS_CHANGED, REVEAL_PANEL_IN_WINDOW, CLOSE_PANEL_IN_WINDOW } from '../shared/ipc-channels'
import { broadcastToAll, focusWindow, getWindow, getWindowType, onWindowClosed, sendToWindow } from './windowRegistry'

/** The latest panel report from each window, keyed by Electron window id. */
const windowPanels = new Map<number, WindowPanelInfo[]>()
const windowPanelListeners = new Set<() => void>()

/** Store a window's reported panels (stamped with its owner id + type) and
 *  rebroadcast the union. Ignored if the window isn't tracked (e.g. a late
 *  report from a window that has since closed). */
export function setWindowPanels(windowId: number, report: WindowPanelReport[]): void {
  const ownerWindowType = getWindowType(windowId)
  if (!ownerWindowType) return
  windowPanels.set(
    windowId,
    report.map((p) => ({
      panelId: p.panelId,
      type: p.type,
      title: p.title || p.type,
      workspaceId: p.workspaceId,
      filePath: p.filePath,
      url: p.url,
      focused: p.focused,
      ownerWindowId: windowId,
      ownerWindowType,
      parentCanvasId: p.parentCanvasId,
      worktreeId: p.worktreeId,
      agentState: p.agentState,
      agentName: p.agentName,
      hasPorts: p.hasPorts,
      codingAgentRunId: p.codingAgentRunId,
      codingAgentOwnerPanelId: p.codingAgentOwnerPanelId,
      codingAgentStatus: p.codingAgentStatus,
    })),
  )
  broadcastWindowPanels()
}

/** Add or refresh one panel immediately, before the owning renderer's normal
 * debounced full report arrives. Used for API-created browsers so the returned
 * panel id can be routed by an immediate follow-up command. The next full
 * report remains authoritative and replaces this provisional row. */
export function upsertWindowPanel(windowId: number, panel: WindowPanelReport): void {
  const ownerWindowType = getWindowType(windowId)
  if (!ownerWindowType) return
  const panels = windowPanels.get(windowId) ?? []
  const next = {
    panelId: panel.panelId,
    type: panel.type,
    title: panel.title || panel.type,
    workspaceId: panel.workspaceId,
    filePath: panel.filePath,
    url: panel.url,
    focused: panel.focused,
    ownerWindowId: windowId,
    ownerWindowType,
    parentCanvasId: panel.parentCanvasId,
    worktreeId: panel.worktreeId,
    agentState: panel.agentState,
    agentName: panel.agentName,
    hasPorts: panel.hasPorts,
    codingAgentRunId: panel.codingAgentRunId,
    codingAgentOwnerPanelId: panel.codingAgentOwnerPanelId,
    codingAgentStatus: panel.codingAgentStatus,
  }
  const index = panels.findIndex((candidate) => candidate.panelId === panel.panelId)
  windowPanels.set(windowId, index < 0
    ? [...panels, next]
    : panels.map((candidate, candidateIndex) => candidateIndex === index ? next : candidate))
  broadcastWindowPanels()
}

/** Drop one panel from the union immediately, before the owning renderer's next
 * debounced report confirms the removal. The close-side mirror of
 * upsertWindowPanel: without it, a close-then-list caller sees the stale row
 * merged back in from here for the report interval and reads it as "still
 * open". The next full report remains authoritative either way. */
export function removeWindowPanel(panelId: string): void {
  for (const [windowId, panels] of windowPanels.entries()) {
    const next = panels.filter((p) => p.panelId !== panelId)
    if (next.length === panels.length) continue
    windowPanels.set(windowId, next)
    broadcastWindowPanels()
    return
  }
}

/**
 * The union of panels across ALL live windows (main + detached), as a shadow
 * list every window can read to discover panels it doesn't host. Each entry
 * carries its owning window (so it can be focused + asked to reveal the panel)
 * and, for canvas children, the parent canvas. A receiving window filters out
 * its own panels by id. (The getWindow guard drops any entry whose window died
 * without a clean close.)
 */
export function getWindowPanels(): WindowPanelInfo[] {
  const result: WindowPanelInfo[] = []
  for (const [windowId, panels] of windowPanels.entries()) {
    if (!getWindow(windowId)) continue
    result.push(...panels)
  }
  return result
}

/** Observe real changes to the cross-window union. Mission waits use this same
 * event-driven registry instead of polling renderer windows. */
export function subscribeWindowPanels(listener: () => void): () => void {
  windowPanelListeners.add(listener)
  return () => windowPanelListeners.delete(listener)
}

// The union is rebroadcast on every window report, so guard on a cheap signature
// to push only on real changes.
let lastWindowPanelSignature = ''

/** Recompute the window-panel union and broadcast it to all windows, but only
 *  when it actually changed since the last broadcast. */
export function broadcastWindowPanels(): void {
  const panels = getWindowPanels()
  const signature = panels
    .map((p) => `${p.ownerWindowId}:${p.panelId}:${p.type}:${p.title}:${p.workspaceId}:${p.filePath ?? ''}:${p.url ?? ''}:${p.focused ? 1 : 0}:${p.parentCanvasId ?? ''}:${p.worktreeId ?? ''}:${p.agentState ?? ''}:${p.agentName ?? ''}:${p.hasPorts ? 1 : 0}:${p.codingAgentRunId ?? ''}:${p.codingAgentOwnerPanelId ?? ''}:${p.codingAgentStatus ?? ''}`)
    .sort()
    .join('|')
  if (signature === lastWindowPanelSignature) return
  lastWindowPanelSignature = signature
  broadcastToAll(WINDOW_PANELS_CHANGED, panels)
  for (const listener of windowPanelListeners) listener()
}

/** Focus the window that owns `panelId` and ask it to reveal the panel within
 *  itself. Works for any window type. Returns false if no live window owns it. */
export function revealWindowPanel(panelId: string): boolean {
  const owner = getWindowPanels().find((p) => p.panelId === panelId)
  if (!owner) return false
  const win = getWindow(owner.ownerWindowId)
  if (!win) return false
  focusWindow(win)
  sendToWindow(owner.ownerWindowId, REVEAL_PANEL_IN_WINDOW, panelId)
  return true
}

/** Ask the window that owns `panelId` to close the panel (behind its own
 *  dirty/running confirmation gates). Focuses the owner first so the gates'
 *  dialogs are visible. Returns false if no live window owns it. */
export function closeWindowPanel(panelId: string): boolean {
  const owner = getWindowPanels().find((p) => p.panelId === panelId)
  if (!owner) return false
  const win = getWindow(owner.ownerWindowId)
  if (!win) return false
  focusWindow(win)
  sendToWindow(owner.ownerWindowId, CLOSE_PANEL_IN_WINDOW, panelId)
  return true
}

// A closing window drops its panels from the union; rebroadcast so the remaining
// windows update. (onWindowClosed fires before the registry deletes its entries,
// but the union is keyed off this module's own map, which we clear here.)
onWindowClosed((windowId) => {
  if (windowPanels.delete(windowId)) broadcastWindowPanels()
})
