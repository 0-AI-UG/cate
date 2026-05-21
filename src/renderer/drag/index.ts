// =============================================================================
// drag — public surface. Consumers import from this barrel; internal modules
// (resolve, commit, runtime, etc.) stay un-exported except where they're used
// by tests or the dispatcher.
// =============================================================================

export type {
  DragSource,
  DropTarget,
  DragState,
  DragOpSourceSpec,
  DragEvent,
  DragEffect,
  RuntimeState,
} from './types'
export { INITIAL_DRAG_STATE, INITIAL_RUNTIME_STATE } from './types'

export { useDragStore } from './store'
export { useDragOp } from './useDragOp'
export {
  useDragSourceVisibility,
  useTabSourceVisibility,
  type DragSourceVisibility,
} from './useDragSourceVisibility'
export {
  selectDragSourceRole,
  selectDragSourceRoleForTab,
  type DragSourceRole,
} from './selectors'

export { default as DragOverlay } from './Overlay'
export { DockZoneDropIndicator } from './ZoneIndicator'

export {
  registerDropZone,
  getDropZoneEntries,
  resolveDropEdge,
  type DropZoneEntry,
} from './registry'

export {
  setupCrossWindowDragListeners,
  type RemoteDropTarget,
  type RemoteDropHandler,
} from './crossWindow'

// Pure utilities — exported for tests + the few callers (resolve.ts is used
// by the crossWindow bridge, geometry helpers used by the dispatcher).
export {
  resolveDrop,
  defaultDropEnvironment,
  type DropEnvironment,
} from './resolve'
export { commitDrop, type CommitContext } from './commit'
export {
  cursorToCanvasOrigin,
  ghostScreenRect,
  normalizeGrabOffset,
} from './geometry'

// Runtime — exported for tests + advanced consumers.
export { reduce, initial as initialRuntime } from './runtime'
