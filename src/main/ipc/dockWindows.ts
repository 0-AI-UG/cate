import { BrowserWindow, ipcMain } from 'electron'
import {
  sendToWindow,
  broadcastToAll,
  setDockWindowState,
  listDockWindows,
  windowFromEvent,
} from '../windowRegistry'
import { revealWindowPanel, openWindowReviewPanel, closeWindowPanel, completeWindowPanelClose } from '../windowPanels'
import { collectTopLevelPanelIds } from '../windows/dockState'
import { revealWindow } from '../windows/reveal'
import type {
  CateWindowParams,
  DetachedDockWindowSnapshot,
  DockWindowInitPayload,
  DockWindowSyncState,
} from '../../shared/types'
import {
  DOCK_WINDOW_INIT,
  DOCK_WINDOW_SYNC_STATE,
  DOCK_WINDOWS_LIST,
  DOCK_WINDOW_RESTORE,
  FOCUS_WINDOW_PANEL,
  OPEN_WINDOW_REVIEW,
  CLOSE_WINDOW_PANEL,
  CLOSE_PANEL_IN_WINDOW_RESULT,
  WORKTREE_REMOVED,
} from '../../shared/ipc-channels'
import type { ReviewPanelOpenRequest } from '../../shared/types'

interface DockWindowDeps {
  createWindow: (params?: CateWindowParams) => BrowserWindow
}

export function registerDockWindowHandlers({ createWindow }: DockWindowDeps): void {
  // Dock window state sync (renderer -> main for session persistence)
  ipcMain.handle(DOCK_WINDOW_SYNC_STATE, async (event, state: unknown) => {
    const win = windowFromEvent(event)
    if (!win) return
    setDockWindowState(win.id, state as DockWindowSyncState)
  })

  // List all dock windows with state and bounds
  ipcMain.handle(DOCK_WINDOWS_LIST, async () => {
    return listDockWindows()
  })

  // Reveal a panel that lives in another window: find its owner, focus that
  // window, and ask it to bring the panel forward within itself.
  ipcMain.handle(FOCUS_WINDOW_PANEL, async (_event, panelId: string) => {
    revealWindowPanel(panelId)
  })

  // Retarget an existing Review panel in whichever renderer owns it, then
  // reveal that panel in its window.
  ipcMain.handle(OPEN_WINDOW_REVIEW, async (
    _event,
    panelId: string,
    request: ReviewPanelOpenRequest,
  ) => openWindowReviewPanel(panelId, request))

  // Close a panel that lives in another window: route the request to its owner,
  // which runs its own dirty/running confirmation gates before closing.
  ipcMain.handle(CLOSE_WINDOW_PANEL, async (_event, panelId: string) => {
    return closeWindowPanel(panelId)
  })

  ipcMain.handle(CLOSE_PANEL_IN_WINDOW_RESULT, async (event, requestId: string, closed: boolean) => {
    const win = windowFromEvent(event)
    if (!win) return
    completeWindowPanelClose(win.id, requestId, closed)
  })

  ipcMain.handle(WORKTREE_REMOVED, async (_event, workspaceId: string, worktreeId: string) => {
    broadcastToAll(WORKTREE_REMOVED, workspaceId, worktreeId)
  })

  // Session restore of a detached dock window — rebuilds the FULL window (every
  // top-level tab + their terminal-replay / canvas-children hydration) from its
  // persisted snapshot, rather than synthesizing a single tab via DRAG_DETACH.
  // PTYs are dead on restore (terminals replay scrollback), so no terminal
  // buffering is needed and bounds come straight from the snapshot.
  ipcMain.handle(DOCK_WINDOW_RESTORE, async (
    _event,
    payload: DetachedDockWindowSnapshot & { initPayload: DockWindowInitPayload },
  ) => {
    const { initPayload, bounds, workspaceId } = payload
    const topLevelIds = collectTopLevelPanelIds(initPayload.dockState)
    const firstId = topLevelIds[0]
    if (!firstId) return null
    const firstPanel = initPayload.panels[firstId]
    if (!firstPanel) return null

    const newWin = createWindow({
      type: 'dock',
      workspaceId: workspaceId || undefined,
    })

    if (bounds) newWin.setBounds(bounds)

    newWin.webContents.once('did-finish-load', () => {
      sendToWindow(newWin.id, DOCK_WINDOW_INIT, initPayload)
      revealWindow(newWin, { focus: false })
    })

    return newWin.id
  })
}
