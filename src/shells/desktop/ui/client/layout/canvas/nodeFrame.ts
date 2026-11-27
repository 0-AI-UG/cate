// What a frameless panel's view (`chrome.frameless`: a sticky note, a text
// block) gets from the canvas node it sits in, since it has no tab bar to
// grab: a way to start moving the node, to tell a move from a click, and,
// for an `autoSize` type, to give the node the size its content needs.
// Null for a view that is not frameless on a canvas.

import { createContext, useContext } from 'react'
import type { Size } from '@workspace/canvas/contract'

export interface CanvasNodeFrame {
  /** A press that may become a move of the node (or of its selection). */
  startDrag(event: React.MouseEvent): void
  /** The press that just ended moved the node: it was not a click. */
  wasDragged(): boolean
  /** The node takes `size` now; it is saved once sizing pauses. */
  fit(size: Size): void
}

export const CanvasNodeFrameContext = createContext<CanvasNodeFrame | null>(null)

export function useCanvasNodeFrame(): CanvasNodeFrame | null {
  return useContext(CanvasNodeFrameContext)
}
