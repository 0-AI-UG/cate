// =============================================================================
// drag — public surface. Consumers import from this barrel; internal modules
// (resolve, commit, runtime, etc.) stay un-exported except where they're used
// by tests or the dispatcher.
// =============================================================================

export { useDragStore } from './store'
export { useDragOp } from './useDragOp'
export {
  useDragSourceVisibility,
  useTabSourceVisibility,
} from './useDragSourceVisibility'

export { default as DragOverlay } from './Overlay'
export { DockZoneDropIndicator } from './ZoneIndicator'

export { registerDropZone } from './registry'

export { setupCrossWindowDragListeners } from './crossWindow'
