import { ipcMain } from 'electron'
import { windowFromEvent, closeWindowsForWorkspace, getActiveMainWindow, sendToWindow } from '../windowRegistry'
import { anyWindowFullscreen } from '../windows/fullscreen'
import {
  WINDOW_SET_TITLE,
  WINDOW_MINIMIZE,
  WINDOW_TOGGLE_MAXIMIZE,
  WINDOW_CLOSE,
  WINDOW_IS_MAXIMIZED,
  WINDOW_FULLSCREEN_STATE,
  WINDOW_CLOSE_FOR_WORKSPACE,
  RUN_ACTION_IN_MAIN,
  MENU_TRIGGER_ACTION,
} from '../../shared/ipc-channels'

export function registerWindowControlHandlers(): void {
  // Renderer-driven title sync — used so each native macOS tab shows the
  // active workspace name instead of the generic app title.
  ipcMain.handle(WINDOW_SET_TITLE, async (event, title: string) => {
    const win = windowFromEvent(event)
    if (!win) return
    if (typeof title === 'string' && title.length > 0) {
      win.setTitle(title)
    }
  })

  // Custom window controls (frameless Windows/Linux chrome). Per-window: resolve
  // the calling window from the IPC sender so a panel/dock window controls itself.
  ipcMain.handle(WINDOW_MINIMIZE, (event) => {
    windowFromEvent(event)?.minimize()
  })
  ipcMain.handle(WINDOW_TOGGLE_MAXIMIZE, (event) => {
    const win = windowFromEvent(event)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.handle(WINDOW_CLOSE, (event) => {
    windowFromEvent(event)?.close()
  })

  // Close every detached (dock) window belonging to a workspace — used by the
  // renderer when a workspace is reloaded so its detached windows are discarded.
  ipcMain.handle(WINDOW_CLOSE_FOR_WORKSPACE, async (_e, workspaceId: string) => {
    closeWindowsForWorkspace(workspaceId)
  })

  // Forward a workspace-level action invoked from a detached window to the main
  // window, which owns the real workspace + session. Without this, "reload
  // workspace" run from a detached window operates on that window's stub store
  // and destroys the window instead of reloading the project.
  ipcMain.handle(RUN_ACTION_IN_MAIN, async (_e, action: string) => {
    const main = getActiveMainWindow()
    if (main) sendToWindow(main.id, MENU_TRIGGER_ACTION, action)
  })
  ipcMain.on(WINDOW_IS_MAXIMIZED, (event) => {
    event.returnValue = windowFromEvent(event)?.isMaximized() ?? false
  })

  // Synchronous fullscreen getter — renderers hit this on every drag
  // mousemove to decide whether to enter dock-drag / cross-window mode.
  // sendSync is fine at ~60 Hz and guarantees no stale state.
  ipcMain.on(WINDOW_FULLSCREEN_STATE, (event) => {
    event.returnValue = anyWindowFullscreen()
  })
}
