import { BrowserWindow, ipcMain } from 'electron'
import {
  sendToWindow,
  setDockWindowState,
  listDockWindows,
  windowFromEvent,
} from '../windowRegistry'
import { revealWindowPanel } from '../windowPanels'
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
} from '../../shared/ipc-channels'

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
