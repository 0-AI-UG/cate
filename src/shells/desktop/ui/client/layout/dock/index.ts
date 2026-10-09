// ui/client/layout/dock public entry: the dock views over the document's dock
// trees (windows and canvas node mini docks) and the slots other modules
// decorate tabs through.

export { DockView, dockKey, sameDockTree, type DockViewProps } from './DockView'
export { EmptyDockChooser } from './EmptyDockChooser'
export { DockTabStack, type DockTabStackProps } from './DockTabStack'
export { DockTabBar, DropGhostChip, TabIcon, TabPill, type DockTabBarProps } from './DockTabBar'
export { DockLayout } from './DockLayout'
export { DockSplitContainer } from './DockSplitContainer'
export { DockResizeHandle } from './DockResizeHandle'
export { NewTabButton, DockTabContextMenu, DockMenuPortalContext, newTabItems, type NewTabItem } from './NewTabMenu'
export { useDockTabActions, type DockTabActionsParams } from './useDockTabActions'
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
  registerTabMenuItems,
  tabMenuContributions,
  registerPanelChromeOverlay,
  panelChromeOverlays,
  type TabDecoration,
  type TabDecorationHook,
  type TabMenuContext,
  type TabMenuContribution,
  type PanelChromeOverlay,
} from './decorations'
