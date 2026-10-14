// client/host public entry: the panel side of the client core: definitions,
// session handles, creating, closing, focusing and revealing panels, panel
// targeting, opening links, creation menus and the action registry. No UI:
// each shell hosts panels in its own UI.

export {
  registerPanelDefinitions,
  panelDefinition,
  panelCheckoutHooks,
  panelDefinitions,
  panelLabel,
  panelMinimumSize,
  panelDefaultSize,
  panelDropSize,
  canLiveOnCanvas,
  keepsMounted,
  creatableDefinitions,
  panelTypeOpening,
  MIN_PANE_SIZE,
} from './definitions'
export {
  attachSessions,
  acquireSession,
  sessionOwner,
  subscribeSessions,
  type ConnectionLookup,
} from './sessions'
export {
  activeLayoutOf,
  activeLayoutId,
  switchLayout,
  addLayout,
  removeLayout,
  moveLayout,
  renameLayout,
  showLayoutsOf,
} from './layouts'
export { demandSurface, isSurfaceDemanded, demandedSurfaces, subscribeDemandedSurfaces } from './surfaceDemand'
export { registerSurface, runSurfaceRequest, serveSurfaces, type SurfaceHandler } from './surfaces'
export { keepMountedPanelIds, setEqual } from './keepMounted'
export { createPanel, clientPanelKit, inheritedCheckout, newId } from './createPanel'
export { openLink, panelShowingFile, type LinkTarget, type OpenLinkOptions } from './links'
export { closePanel, closePanels, confirmClose, registerPanelCloseGuard, type CloseGuard, type CloseGuardContext, type ConfirmedClose } from './close'
export { activeTabOf, focusPanel, focusedPanelId, focusedLeafIn, focusedLeafPanelId, selectTab, selectTabAt, focusPaneBeside, toggleExpandedPane } from './focus'
export { revealPanel, selectPanelAt, stepPanel, installRevealHooks, CANVAS_REVEAL_INTENT, type RevealHooks } from './reveal'
export {
  registerActions,
  actionSupported,
  canRunAction,
  runAction,
  availableActions,
  subscribeActions,
  actionsVersion,
  requestPanelRename,
  onPanelRenameRequest,
  requestPanelShortcut,
  onPanelShortcut,
  type ActionBinding,
  type ActionContext,
} from './actions'
export { registerPanelActions, newPanelActionId, panelCommandActionId } from './panelActions'
export { worktreeChoices, creationMenuItems, creationPick, type WorktreeChoice, type CreationPick } from './creation'
export {
  requestPanelTarget,
  pickPanelPlace,
  pickNewPanelPlace,
  createPanelFrom,
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
