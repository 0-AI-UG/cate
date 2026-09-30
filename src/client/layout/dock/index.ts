// client/layout/dock public entry: the dock views over the document's dock
// trees (windows and canvas node mini docks), maximize and minimize as client
// presentations, and the slots other modules decorate tabs through.

export { DockView, dockKey, sameDockTree, type DockViewProps } from './DockView'
export { EmptyDockChooser } from './EmptyDockChooser'
export { DockTabStack, type DockTabStackProps } from './DockTabStack'
export { DockTabBar, TabIcon, TabPill, type DockTabBarProps } from './DockTabBar'
export { DockLayout } from './DockLayout'
export { DockSplitContainer } from './DockSplitContainer'
export { DockResizeHandle } from './DockResizeHandle'
export { NewTabButton, DockTabContextMenu, DockMenuPortalContext, splitMenuItems, type SplitMenuItem } from './NewTabMenu'
export { useDockTabActions, materializeWindow, type DockTabActionsParams } from './useDockTabActions'
export {
  presentationsFor,
  createPresentationStore,
  presentedDock,
  presentedWindowDock,
  presentedNodeDock,
  promotedPanels,
  materialize,
  materializeDock,
  resetPresentations,
  type DockPresentation,
  type PresentationStore,
} from './presentation'
export { usePresentations } from './usePresentations'
export {
  layoutMinimum,
  canSplitLayout,
  canSplitPane,
  clampSplitDelta,
  SPLIT_DIVIDER_SIZE,
  MIN_PANE_SIZE,
  type PanelTypeOf,
} from './sizing'
export {
  registerTabDecorations,
  useTabDecorations,
  useAgentTabDecorations,
  registerTabMenuItems,
  tabMenuContributions,
  registerPanelChromeOverlay,
  panelChromeOverlays,
  AgentChangesOverlay,
  type TabDecoration,
  type TabDecorationHook,
  type TabMenuContext,
  type TabMenuContribution,
  type PanelChromeOverlay,
} from './decorations'
