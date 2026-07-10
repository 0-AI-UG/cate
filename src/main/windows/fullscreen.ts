import { listWindows } from '../windowRegistry'

/** True when any existing Cate BrowserWindow is in macOS native fullscreen.
 *  Used to reject window-creation IPCs so the app can never "escape" into a
 *  separate Space while the user is in fullscreen mode. */
export function anyWindowFullscreen(): boolean {
  for (const w of listWindows()) {
    try { if (w.isFullScreen()) return true } catch { /* noop */ }
  }
  return false
}
