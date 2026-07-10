import { app } from 'electron'
import log from '../logger'
import { getActiveMainWindow, focusWindow, sendToWindow } from '../windowRegistry'
import { IS_E2E } from '../windows/reveal'
import { APP_OPEN_PATH } from '../../shared/ipc-channels'

// ---------------------------------------------------------------------------
// Dock / "Open With..." folder opens (macOS `open-file` event)
//
// Fires when the user drops a folder onto the dock icon or opens one with
// Cate via Finder. We resolve the folder to a directory and forward it to
// the main renderer, which creates a new workspace rooted at that path.
//
// The event can fire *before* the window is ready, so we queue paths and
// flush once the main window signals ready-to-show.
// ---------------------------------------------------------------------------

const pendingOpenPaths: string[] = []
let mainWindowReady = false

/** Update the readiness gate that controls whether open-path events are
 *  delivered immediately or queued. Called from the index bootstrap and the
 *  `activate` lifecycle handler around main-window creation. */
export function setMainWindowReady(ready: boolean): void {
  mainWindowReady = ready
}

function deliverOpenPath(p: string): void {
  const win = getActiveMainWindow()
  if (!win || !mainWindowReady) {
    pendingOpenPaths.push(p)
    return
  }
  try {
    // Skip in e2e so opening a path never foregrounds the shared Electron bundle.
    if (!IS_E2E) focusWindow(win)
  } catch { /* noop */ }
  sendToWindow(win.id, APP_OPEN_PATH, p)
}

export function flushPendingOpenPaths(): void {
  if (!pendingOpenPaths.length) return
  const win = getActiveMainWindow()
  if (!win) return
  for (const p of pendingOpenPaths.splice(0)) {
    sendToWindow(win.id, APP_OPEN_PATH, p)
  }
}

/** Register the macOS `open-file` handler. Must be called at index top-level
 *  (not inside whenReady) so paths opened before the app is ready are captured
 *  into the pending queue rather than dropped. */
export function registerOpenFileHandler(): void {
  app.on('open-file', (event, filePath) => {
    event.preventDefault()
    log.info('open-file event: %s', filePath)
    deliverOpenPath(filePath)
  })
}
