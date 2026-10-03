// ui/client/layout/canvas public entry: the canvas view, its per-canvas view
// stores, the ports the shell installs, and the helpers shortcuts, the drag
// layer, the palette and the e2e harness use.

export { CanvasView, type CanvasViewProps } from './CanvasView'
export { CanvasPanelList } from './CanvasPanelList'
export { installMinimapBadges } from './Minimap'
export { CanvasViewProvider, useCanvasView, useCanvasViewStore } from './context'
export { installCanvasSlots, canvasSlots, type CanvasSlots, type NodeDockProps } from './slots'
export { registerCanvasToolbarItem, type CanvasToolbarItem, type CanvasToolbarItemProps } from './toolbarItems'
export { useCanvasToolbarAction, requestCanvasToolbarAction, type CanvasToolbarAction } from './toolbarAction'
export { CanvasToolbarButton } from './CanvasToolbarButton'
export { useCanvasUi, type CanvasTool } from './uiState'
export { showContextMenu, type ContextMenuItem } from './contextMenu'
export { worktreeColor, useWorktreeMembership, setTerritoryPerfCounter } from './worktree'
export { setCanvasPerfCounter } from './perf'

export {
  createCanvasView,
  activeNodePanelId,
  type CanvasView as CanvasViewModel,
  type CanvasViewState,
  type CanvasViewActions,
  type CanvasViewStore,
  type CanvasDocumentSource,
  type CanvasClientStateSink,
  type ViewNode,
  type NodeAnimation,
  type SnapGuideLine,
  type Marquee,
  type PendingPanelTarget,
  type PanelTargetRequest,
  type PanelTargetAvailability,
  type CanvasPanelTargetChoice,
} from './store'
export { canvasViewFor, setCanvasAnimations, resetCanvasViews } from './registry'
export { focusedNodeId, isGroupDragMember, isSelected, withLead } from './selection'
export { ZOOM_MIN, ZOOM_MAX, ZOOM_DEFAULT, PAN_STEP, NODE_CORNER_RADIUS, clampZoom } from './constants'
export {
  canvasHost,
  panelDefinition,
  panelDefaultSize,
  panelMinimumSize,
  installCanvasDrag,
  canvasDrag,
  type CanvasHost,
  type CanvasDragPort,
  type CanvasDragState,
  type CanvasNodeDragSource,
  type CanvasTabDragSource,
} from './ports'
export { installCanvasSettings, canvasSetting, type CanvasSettingsSources } from './settings'
export { useCanvasSetting, useWorkspaceSetting } from './settingsHooks'
export { BUILTIN_WALLPAPERS } from './background/builtinWallpapers'
export { installCanvasBackgroundPort, canvasBackgroundPort, type CanvasBackgroundPort } from './background'
export { installScreenshotPort, screenshotPort, type ScreenshotPort, type RecentScreenshot } from './screenshots'
export {
  primaryCanvasId,
  activeCanvasId,
  placePanelOnCanvas,
} from './access'
export { createPanelOnCanvas, inheritedCheckout, checkoutHooks, type CanvasCreateOptions } from './actions'
export { canvasAtPoint, canvasContainerFor, type CanvasAtPoint } from './parts/dom'
export { isMouseWheel, type WheelLike } from './parts/wheelIntent'
export { createCanvasE2E, type CanvasE2E } from './e2e'
export { installCanvasRelationHost } from './relations'
