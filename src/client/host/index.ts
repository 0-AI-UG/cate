// client/host public entry: the panel side of the client core: definitions,
// session handles, creating, closing, focusing, revealing and moving panels
// into the dock, panel targeting, opening links, creation menus and the
// action registry. No UI: each shell hosts panels in its own UI.

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
export { demandSurface, isSurfaceDemanded, demandedSurfaces, subscribeDemandedSurfaces } from './surfaceDemand'
export { registerSurface, runSurfaceRequest, serveSurfaces, type SurfaceHandler } from './surfaces'
export { keepMountedPanelIds, setEqual } from './keepMounted'
export { createPanel, clientPanelKit, inheritedCheckout, newId } from './createPanel'
export { openLink, openClickedLink, installLinkSettings, panelShowingFile, type LinkSettings, type LinkTarget, type OpenLinkOptions } from './links'
export { markdownLinkTarget, markdownPath } from './markdownLinks'
export { closePanel, closePanels, confirmClose, registerPanelCloseGuard, type CloseGuard, type CloseGuardContext, type ConfirmedClose } from './close'
export { activeTabOf, focusPanel, focusedPanelId, focusedLeafIn, focusedLeafPanelId, selectTab } from './focus'
export { canMoveIntoDock, moveIntoDock } from './moveIntoDock'
export { revealPanel, installRevealHooks, CANVAS_REVEAL_INTENT, type RevealHooks } from './reveal'
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
