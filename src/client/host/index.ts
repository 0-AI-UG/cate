// client/host public entry: the panel renderer, the view and definition
// slots, session attachment, persistent native surfaces, creating, closing,
// focusing and revealing panels, and the action registry.

export { registerPanelView, panelView, type PanelViewProps } from './views'
export {
  registerPanelDefinitions,
  panelDefinition,
  panelDefinitions,
  panelLabel,
  panelMinimumSize,
  panelDefaultSize,
  panelDropSize,
  canLiveOnCanvas,
  keepsMounted,
  splitMenuTypes,
  panelTypeOpening,
  missingFeatures,
  MIN_PANE_SIZE,
} from './definitions'
export {
  installSessionSource,
  sessionSourceFrom,
  acquireSession,
  type SessionSource,
  type ConnectionLookup,
} from './sessions'
export {
  PanelHost,
  PanelView,
  PanelSuspense,
  PanelUnavailable,
  WorkspaceReady,
  PanelPlacementContext,
} from './PanelHost'
export { PanelSessionBoundary, PanelVisibilityContext, usePanelSession } from './PanelSessionBoundary'
export { PersistentPanelHost } from './PersistentPanelHost'
export {
  PanelSurfaceSlot,
  registerPanelSurface,
  syncPanelSurfaces,
  setSurfacePerfCounter,
  isSurfaceVisible,
  subscribeSurfaceVisibility,
} from './surfaceRegistry'
export { demandSurface, useDemandedSurfaces, isSurfaceDemanded } from './surfaceDemand'
export { useKeepMountedPanelIds, keepMountedPanelIds, setEqual } from './keepMounted'
export { PanelChromeContext, PanelChromeProvider, useClaimPanelCorner, type PanelChromeApi } from './panelChrome'
export { createPanel, clientPanelKit, newId } from './createPanel'
export { closePanel, closePanels, confirmClose, registerPanelCloseGuard, type CloseGuard, type CloseGuardContext, type CloseOptions } from './close'
export { activeTabOf, focusPanel, focusedPanelId, focusedLeafIn, focusedLeafPanelId, selectTab } from './focus'
export { revealPanel, installRevealHooks, CANVAS_REVEAL_INTENT, type RevealHooks } from './reveal'
export {
  registerAction,
  runAction,
  hasAction,
  newPanelAction,
  registerHostActions,
  requestPanelRename,
  onPanelRenameRequest,
  requestPanelShortcut,
  onPanelShortcut,
  type ActionContext,
  type ActionHandler,
} from './actions'
export {
  requestPanelTarget,
  pickPanelPlace,
  installCanvasTargetPicker,
  type PanelPlace,
  type PanelTarget,
  type PanelTargetAvailability,
  type PanelTargetRequest,
  type CanvasTargetPicker,
  type CanvasTargetRequest,
  type CanvasTargetChoice,
} from './panelTargetPicker'
export { panelRowLabel } from './panelTitle'
