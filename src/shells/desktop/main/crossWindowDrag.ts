// Panel drags across windows. The source window starts a drag; main follows
// the OS cursor, moves the ghost window (hidden while the cursor is over an
// app window, which draws its own overlay) and tells the other windows where
// the pointer is. On release the source ends the drag; the window under the
// pointer claims it within a short wait and applies the placement op itself.
// Unclaimed, the source decides (detach to a new window, or back in place).

import type { Bounds, DragPayload, DragPointer } from '../contract'

const CROSS_WINDOW_POLL_MS = 33
const CLAIM_WAIT_MS = 80

export interface DragWindow {
  contentsId: number
  bounds: Bounds
}

export interface DragGhost {
  show(payload: DragPayload): void
  move(x: number, y: number): void
  setVisible(visible: boolean): void
  destroy(): void
}

export interface CrossWindowDragDeps {
  cursor(): { x: number; y: number }
  windows(): DragWindow[]
  ghost: DragGhost
  /** Pointer and end notices to every window but `exceptContents`. */
  broadcast(channel: 'pointer' | 'ended', payload: DragPointer | string, exceptContents: number): void
  anyFullscreen(): boolean
  newId(): string
  pollMs?: number
  claimWaitMs?: number
}

interface ActiveDrag {
  id: string
  source: number
  payload: DragPayload
  claimedBy: number | null
  timer: ReturnType<typeof setInterval> | null
  onClaim: (() => void) | null
}

function isInsideAnyWindow(point: { x: number; y: number }, windows: DragWindow[]): boolean {
  return windows.some(({ bounds: b }) => point.x >= b.x && point.x < b.x + b.width && point.y >= b.y && point.y < b.y + b.height)
}

export function createCrossWindowDrag(deps: CrossWindowDragDeps) {
  let drag: ActiveDrag | null = null

  const stop = (current: ActiveDrag) => {
    if (current.timer) clearInterval(current.timer)
    current.timer = null
    deps.ghost.destroy()
  }

  return {
    /** The drag id, or null when a drag cannot leave the window (fullscreen). */
    start(source: number, payload: DragPayload): string | null {
      // A ghost in fullscreen would land in another Space.
      if (deps.anyFullscreen()) return null
      if (drag) stop(drag)
      const current: ActiveDrag = { id: deps.newId(), source, payload, claimedBy: null, timer: null, onClaim: null }
      drag = current
      deps.ghost.show(payload)
      current.timer = setInterval(() => {
        if (drag !== current) return
        const point = deps.cursor()
        deps.ghost.move(point.x, point.y)
        deps.ghost.setVisible(!isInsideAnyWindow(point, deps.windows()))
        deps.broadcast('pointer', { dragId: current.id, payload: current.payload, x: point.x, y: point.y }, current.source)
      }, deps.pollMs ?? CROSS_WINDOW_POLL_MS)
      return current.id
    },

    claim(target: number, dragId: string): DragPayload | null {
      const current = drag
      if (!current || current.id !== dragId || current.claimedBy !== null || target === current.source) return null
      current.claimedBy = target
      current.onClaim?.()
      return current.payload
    },

    end(source: number, dragId: string): Promise<{ claimed: boolean }> {
      const current = drag
      if (!current || current.id !== dragId || current.source !== source) return Promise.resolve({ claimed: false })
      stop(current)
      if (current.claimedBy !== null) {
        drag = null
        return Promise.resolve({ claimed: true })
      }
      deps.broadcast('ended', current.id, current.source)
      return new Promise((resolve) => {
        const finish = () => {
          clearTimeout(wait)
          current.onClaim = null
          if (drag === current) drag = null
          resolve({ claimed: current.claimedBy !== null })
        }
        const wait = setTimeout(finish, deps.claimWaitMs ?? CLAIM_WAIT_MS)
        current.onClaim = finish
      })
    },

    cancel(dragId: string): void {
      const current = drag
      if (!current || current.id !== dragId) return
      stop(current)
      drag = null
      deps.broadcast('ended', current.id, -1)
    },

    active: (): string | null => drag?.id ?? null,
  }
}

export type CrossWindowDrag = ReturnType<typeof createCrossWindowDrag>
