// client/layout/windows public entry: document windows drawn in client
// windows, native detached windows kept in step through the shell's
// WindowsPort, closing a window, and the cross-window panel index.

export { WindowView, MainWindowView, showWindow, shownWindow, installWindowReveal, type WindowViewProps } from './WindowView'
export { syncDetachedWindows } from './windowSync'
export { closeDetachedWindow } from './closeWindow'
export { clampToScreens, type ScreenArea } from './bounds'
export { installWindowsPort, windowsPort, type WindowsPort, type WindowRef } from './ports'
export {
  panelWindowIndex,
  panelsByWindow,
  detachedWindows,
  windowTitle,
} from './panelIndex'
