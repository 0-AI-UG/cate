// client/host public entry: the panel side of the client core: definitions,
// session handles, creating, closing, focusing and revealing panels, panel
// targeting, creation menus and the action registry. No UI: the desktop's
// panel hosting is shells/desktop/ui/client/host.

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
  creatableDefinitions,
  panelTypeOpening,
  MIN_PANE_SIZE,
} from './definitions'
export {
  installSessionSource,
  sessionSourceFrom,
  acquireSession,
  sessionOwner,
  subscribeSessionSource,
  type SessionSource,
  type ConnectionLookup,
} from './sessions'
export {
  activeLayoutOf,
  activeLayoutId,
  switchLayout,
  stepLayout,
  selectLayoutAt,
  addLayout,
  removeLayout,
  moveLayout,
  renameLayout,
} from './layouts'
export { demandSurface, isSurfaceDemanded, demandedSurfaces, subscribeDemandedSurfaces } from './surfaceDemand'
export { keepMountedPanelIds, setEqual } from './keepMounted'
export { createPanel, clientPanelKit, newId } from './createPanel'
export { openUrlFor, openUrlInPanel } from './openUrl'
export { closePanel, closePanels, confirmClose, registerPanelCloseGuard, type CloseGuard, type CloseGuardContext } from './close'
export { activeTabOf, focusPanel, focusedPanelId, focusedLeafIn, focusedLeafPanelId, selectTab } from './focus'
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
