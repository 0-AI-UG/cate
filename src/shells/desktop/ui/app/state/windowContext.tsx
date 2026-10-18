// Which document window a React subtree renders. The main window is
// `MAIN_WINDOW`; a detached window's shell provides its id. Code asks the
// document for the window's kind rather than asking which shell it is.

import { createContext, useContext } from 'react'
import { MAIN_WINDOW, type WindowId } from '@workspace/document/contract'

export const WindowIdContext = createContext<WindowId>(MAIN_WINDOW)

export function useWindowId(): WindowId {
  return useContext(WindowIdContext)
}

// The window this renderer shows, for code outside React (shortcuts). One
// renderer shows one document window.
let shownWindowId: WindowId = MAIN_WINDOW

export function setShownWindowId(windowId: WindowId): void {
  shownWindowId = windowId
}

export function shownWindow(): WindowId {
  return shownWindowId
}
