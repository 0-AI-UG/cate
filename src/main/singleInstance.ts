import type { BrowserWindow } from 'electron'

/** Un-minimize (if needed) and bring a single window to the foreground.
 *  The shared "make this window the active one" idiom used wherever the app
 *  surfaces an existing window (second-instance, open-path, notification click). */
export function focusWindow(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore()
  win.focus()
}

/**
 * Bring the already-running instance's window to the foreground.
 *
 * Wired to Electron's 'second-instance' event: when a second Cate launch is
 * blocked by the single-instance lock, we focus the existing window instead of
 * spinning up a rival process. Two Cate processes on the same project both
 * autosave .cate/workspace.json and each then sees the other's writes as an
 * external edit, firing a spurious "Reload workspace from disk?" prompt on a
 * ~30s loop. Prefers a live (non-destroyed) window and un-minimizes it first.
 */
export function focusRunningInstanceWindow(windows: BrowserWindow[]): void {
  const win = windows.find((w) => !w.isDestroyed())
  if (!win) return
  focusWindow(win)
}
