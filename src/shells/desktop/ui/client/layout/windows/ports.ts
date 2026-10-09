// What the windows view needs from a shell that declares `windows`: native
// windows for the document's detached windows. The desktop shell implements
// it; a client without `windows` never installs one.

import type { Rect } from '@workspace/canvas/contract'

export interface WindowRef {
  workspaceId: string
  windowId: string
}

export interface WindowsPort {
  /** Opens (or raises) a native window showing the document window. A
   *  window's position is this device's: the shell puts it where this device
   *  last had it, else at `bounds` (clamped to this device's screens), else
   *  where a new window goes. */
  open(window: WindowRef & { bounds?: Rect }): void
  close(window: WindowRef): void
  /** Brings an open window to the front. */
  focus?(window: WindowRef): void
  /** False while a new window cannot open (a fullscreen main window would put
   *  it in another Space). */
  canOpen?(): boolean
}

let port: WindowsPort | null = null

export function installWindowsPort(next: WindowsPort | null): void {
  port = next
}

export function windowsPort(): WindowsPort | null {
  return port
}
