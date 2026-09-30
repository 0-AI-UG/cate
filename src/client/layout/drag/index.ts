// client/layout/drag public entry: drags of tabs and canvas nodes inside and
// across windows, the ghost and drop indicators, file drops, and the shell
// ports (native ghost, cross-window pointer) with the pure logic the desktop
// shell runs behind them.

export { useDragStore, type PendingDetach } from './store'
export { useDragOp, beginDrag, commitDrop, proposeDrop, canDetach, resetDragDispatch } from './useDragOp'
export { useDragSourceVisibility, useTabSourceVisibility, selectDragSourceRole, selectDragSourceRoleForTab, type DragSourceRole } from './selectors'
export { DragOverlay, memberGhostRects } from './Overlay'
export { EdgeDropIndicator } from './EdgeIndicator'
export {
  registerDropZone,
  getDropZoneEntries,
  registerCanvasDropSurface,
  canvasSurfaceFor,
  resolveDropEdge,
  resetDragRegistry,
  type DropZoneEntry,
  type CanvasDropSurface,
} from './registry'
export { resolveDrop, domDropEnvironment, type DropEnvironment, type CanvasHit } from './resolve'
export { dropChanges, detachChange, type DropContext } from './commit'
export { reduce as reduceDrag } from './runtime'
export { setupCrossWindowDrops, shouldIgnoreDragEnd } from './crossWindow'
export { installDragShell, dragShell, type DragShell, type DragGhostPort, type CrossWindowPort, type CrossWindowDrag } from './ports'
export * as dragShellLogic from './shellLogic'
export {
  useFileDropTracker,
  FileDropOverlay,
  useFileDragActive,
  isFileDrag,
  useDockFileDrop,
  installFileDropHandler,
  importDroppedFiles,
  droppedPaths,
  type FileDropHandler,
  type FileDropKind,
} from './fileDrop'
export { acquireBodyClass, releaseBodyClass, pinDocumentCursor, isMiddleClick } from './dom'
export { installGestureLockWatchdog, IDLE_GRACE_MS } from './gestureLockWatchdog'
export { cursorToCanvasOrigin, ghostScreenRect, dockTabGrabOffset, snappedGhostScreenRect } from './geometry'
export {
  INITIAL_DRAG_STATE,
  type DragState,
  type DragSource,
  type DropTarget,
  type DragOpSourceSpec,
  type DragPanel,
  type GhostRect,
} from './types'
