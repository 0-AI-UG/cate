// What the windows view needs from a shell that declares `windows`: native
// windows for the document's detached windows. The desktop shell implements
// it; a client without `windows` never installs one.

import type { Rect } from '@workspace/canvas/contract'

export interface WindowRef {
  workspaceId: string
  windowId: string
}

export interface WindowsPort {
  /** Opens (or raises) a native window showing the document window. `bounds`
   *  are the shared bounds; the shell clamps them to this device's screens. */
  open(window: WindowRef & { bounds: Rect }): void
  close(window: WindowRef): void
  /** The user moved or resized a native window (reported once it settles). */
  onBoundsChanged(listener: (window: WindowRef, bounds: Rect) => void): () => void
  /** Another client moved the window. */
  setBounds?(window: WindowRef, bounds: Rect): void
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
