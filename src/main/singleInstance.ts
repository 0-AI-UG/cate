import type { BrowserWindow } from 'electron'

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
  if (win.isMinimized()) win.restore()
  win.focus()
}
