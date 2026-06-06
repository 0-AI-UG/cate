// =============================================================================
// Window Registry — tracks all BrowserWindows for multi-window IPC routing
// =============================================================================

import { BrowserWindow } from 'electron'
import type { CateWindowType, DockStateSnapshot, PanelState } from '../shared/types'
import { PERF_ENABLED, countIpc } from './perf/perfMonitor'

/** Cheap approximate byte size of IPC args — only computed under CATE_PERF=1. */
function ipcPayloadBytes(args: unknown[]): number {
  let n = 0
  for (const a of args) {
    if (typeof a === 'string') n += a.length
    else if (a == null) continue
    else { try { n += JSON.stringify(a).length } catch { /* circular/unserialisable */ } }
  }
  return n
}

/** All tracked windows keyed by their Electron window ID. */
const windows = new Map<number, BrowserWindow>()

/** Window type for each tracked window. */
const windowTypes = new Map<number, CateWindowType>()

/** Panel metadata for panel windows (set after transfer). */
const panelWindowMeta = new Map<number, { panel: PanelState; workspaceId?: string; terminalPtyId?: string }>()

/** Dock window state — synced periodically from renderer for session persistence. */
const dockWindowState = new Map<number, { dockState: DockStateSnapshot; panels: Record<string, PanelState>; workspaceId: string; terminalPtyIds?: Record<string, string> }>()

/** Workspace a window was opened for (known at creation for dock/panel windows). */
const windowWorkspaceId = new Map<number, string>()

/** The id of the most recently focused main window — the default target for
 *  app-level actions (e.g. panel creation) routed from a detached window. */
let lastFocusedMainWindowId: number | null = null

/**
 * Register a BrowserWindow. Automatically unregisters on close.
 */
export function registerWindow(win: BrowserWindow, type: CateWindowType = 'main', workspaceId?: string): void {
  windows.set(win.id, win)
  windowTypes.set(win.id, type)
  if (workspaceId) windowWorkspaceId.set(win.id, workspaceId)
  // Newest main window becomes the default target until another is focused.
  if (type === 'main') lastFocusedMainWindowId = win.id
  win.on('focus', () => {
    if (windowTypes.get(win.id) === 'main') lastFocusedMainWindowId = win.id
  })
  win.on('closed', () => {
    windows.delete(win.id)
    windowTypes.delete(win.id)
    panelWindowMeta.delete(win.id)
    dockWindowState.delete(win.id)
    windowWorkspaceId.delete(win.id)
    if (lastFocusedMainWindowId === win.id) lastFocusedMainWindowId = null
  })
}

/**
 * The main window that should receive app-level actions routed from a detached
 * window — the last-focused one, falling back to any live main window.
 */
export function getActiveMainWindow(): BrowserWindow | undefined {
  if (lastFocusedMainWindowId != null) {
    const win = windows.get(lastFocusedMainWindowId)
    if (win && !win.isDestroyed()) return win
  }
  for (const [id, type] of windowTypes.entries()) {
    if (type !== 'main') continue
    const win = windows.get(id)
    if (win && !win.isDestroyed()) return win
  }
  return undefined
}

/**
 * The workspace a window belongs to. Known at creation for dock/panel windows;
 * falls back to the latest synced dock state / panel metadata.
 */
export function getWindowWorkspaceId(windowId: number): string | undefined {
  const direct = windowWorkspaceId.get(windowId)
  if (direct) return direct
  const dock = dockWindowState.get(windowId)
  if (dock?.workspaceId) return dock.workspaceId
  return panelWindowMeta.get(windowId)?.workspaceId
}

/**
 * Store panel metadata for a panel window (called after transfer).
 */
export function setPanelWindowMeta(windowId: number, panel: PanelState, workspaceId?: string): void {
  panelWindowMeta.set(windowId, { panel, workspaceId })
}

/**
 * Update the terminal ptyId for a panel window. The renderer reports this
 * shortly after the terminal panel is mounted so that session persistence can
 * later replay its scrollback log.
 */
export function setPanelWindowTerminalPtyId(windowId: number, ptyId: string): void {
  const meta = panelWindowMeta.get(windowId)
  if (!meta) return
  meta.terminalPtyId = ptyId
}

/**
 * Get the window type for a given window ID.
 */
export function getWindowType(id: number): CateWindowType | undefined {
  return windowTypes.get(id)
}

/**
 * Get a window by its Electron window ID.
 */
export function getWindow(id: number): BrowserWindow | undefined {
  const win = windows.get(id)
  if (win && !win.isDestroyed()) return win
  return undefined
}

/** Un-minimize (if needed) and bring a single window to the foreground.
 *  The shared "make this window the active one" idiom used wherever the app
 *  surfaces an existing window (open-path, notification click). */
export function focusWindow(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore()
  win.focus()

  // macOS lets a backgrounded app raise itself on focus(); Windows and Linux do
  // not — their foreground-lock / focus-stealing prevention often leaves focus()
  // only flashing the taskbar. Briefly toggling always-on-top forces the window
  // to the front, then releases it so it isn't actually pinned. (A notification
  // click grants the app the foreground rights this relies on.) Preserve an
  // existing always-on-top state if the window already had one.
  if (process.platform !== 'darwin') {
    const alreadyPinned = win.isAlwaysOnTop()
    win.setAlwaysOnTop(true)
    win.focus()
    if (!alreadyPinned) win.setAlwaysOnTop(false)
  }
}

/**
 * Send an IPC message to a specific window by ID. No-op if window is gone.
 */
export function sendToWindow(windowId: number, channel: string, ...args: unknown[]): void {
  const win = windows.get(windowId)
  if (win && !win.isDestroyed()) {
    if (PERF_ENABLED) countIpc(channel, ipcPayloadBytes(args))
    win.webContents.send(channel, ...args)
  }
}

/**
 * Broadcast an IPC message to ALL tracked windows.
 */
export function broadcastToAll(channel: string, ...args: unknown[]): void {
  if (PERF_ENABLED) countIpc(channel, ipcPayloadBytes(args))
  for (const win of windows.values()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, ...args)
    }
  }
}

/**
 * Broadcast an IPC message to all windows EXCEPT the specified one.
 */
export function broadcastToAllExcept(excludeId: number, channel: string, ...args: unknown[]): void {
  for (const [id, win] of windows.entries()) {
    if (id !== excludeId && !win.isDestroyed()) {
      win.webContents.send(channel, ...args)
    }
  }
}

/**
 * Resolve the BrowserWindow that owns an IPC event's sender.
 * Returns undefined if the window is destroyed or not found.
 */
export function windowFromEvent(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): BrowserWindow | undefined {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win && !win.isDestroyed()) return win
  return undefined
}

/**
 * Get all active panel windows with their metadata and bounds.
 */
export function listPanelWindows(): Array<{ windowId: number; panel: PanelState; workspaceId?: string; bounds: { x: number; y: number; width: number; height: number }; terminalPtyId?: string }> {
  const result: Array<{ windowId: number; panel: PanelState; workspaceId?: string; bounds: { x: number; y: number; width: number; height: number }; terminalPtyId?: string }> = []
  for (const [id, type] of windowTypes.entries()) {
    if (type !== 'panel') continue
    const win = windows.get(id)
    if (!win || win.isDestroyed()) continue
    const meta = panelWindowMeta.get(id)
    if (!meta) continue
    const bounds = win.getBounds()
    result.push({
      windowId: id,
      panel: meta.panel,
      workspaceId: meta.workspaceId,
      bounds,
      terminalPtyId: meta.terminalPtyId,
    })
  }
  return result
}

// =============================================================================
// Dock window state management
// =============================================================================

/**
 * Store dock window state (synced periodically from renderer).
 */
export function setDockWindowState(
  windowId: number,
  state: { dockState: DockStateSnapshot; panels: Record<string, PanelState>; workspaceId: string; terminalPtyIds?: Record<string, string> },
): void {
  dockWindowState.set(windowId, state)
}

/**
 * List all dock windows with their state and bounds.
 */
export function listDockWindows(): Array<{
  windowId: number
  dockState: DockStateSnapshot
  panels: Record<string, PanelState>
  bounds: { x: number; y: number; width: number; height: number }
  workspaceId: string
  terminalPtyIds?: Record<string, string>
}> {
  const result: Array<{
    windowId: number
    dockState: DockStateSnapshot
    panels: Record<string, PanelState>
    bounds: { x: number; y: number; width: number; height: number }
    workspaceId: string
    terminalPtyIds?: Record<string, string>
  }> = []
  for (const [id, type] of windowTypes.entries()) {
    if (type !== 'dock') continue
    const win = windows.get(id)
    if (!win || win.isDestroyed()) continue
    const state = dockWindowState.get(id)
    if (!state) continue
    const bounds = win.getBounds()
    result.push({
      windowId: id,
      ...state,
      bounds,
    })
  }
  return result
}
