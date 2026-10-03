// What the drag system needs from the shell: the native ghost shown while
// the cursor is outside every app window, and the pointer relay to the
// client's other windows (implemented by the desktop shell over its IPC).
// A client without them keeps drags inside its one window.

import type { Point, Size } from '@workspace/canvas/contract'
import type { PanelId } from '@workspace/document/contract'

/** A drag as the shell and the other windows see it. */
export interface CrossWindowDrag {
  dragId: string
  workspaceId: string
  panelId: PanelId
  panelType: string
  title: string
  /** Canvas-space size a drop onto a canvas gives the panel. */
  size: Size
  /** Offset from the ghost's top-left to the cursor, in screen px. */
  grab: Point
}

export interface DragGhostPort {
  /** Shows the native ghost at the cursor; the shell tracks the cursor and
   *  hides the ghost over app windows (which draw their own). */
  show(drag: CrossWindowDrag, screen: Point): void
  hide(dragId: string): void
}

export interface CrossWindowPort {
  /** Source side: the cursor left this window; relay it to the others. */
  begin(drag: CrossWindowDrag, screen: Point): void
  /** Source side: the cursor came back, or the drag was cancelled. */
  cancel(dragId: string): void
  /** Source side: released outside this window. Resolves once another
   *  window claimed the drop, or after the shell's short claim wait. */
  release(dragId: string): Promise<{ claimed: boolean }>
  /** Receiver side: the relayed pointer, in screen px. */
  onPointer(listener: (drag: CrossWindowDrag, screen: Point) => void): () => void
  /** Receiver side: the drag ended in its source window. */
  onEnd(listener: (dragId: string) => void): () => void
  /** Receiver side: take the drop. The shell accepts one claim per drag;
   *  only an accepted claim sends the op. */
  claim(dragId: string): Promise<boolean>
}

export interface DragShell {
  ghost?: DragGhostPort
  crossWindow?: CrossWindowPort
  /** Snap canvas drops to the grid (the `snapToGrid` client setting). */
  snapToGrid?: () => boolean
}

let shell: DragShell = {}

export function installDragShell(next: DragShell): () => void {
  const previous = shell
  shell = next
  return () => { shell = previous }
}

export function dragShell(): DragShell {
  return shell
}
