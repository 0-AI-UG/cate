// ui/app public entry: the sidebar frame, the command palette, the
// settings window and its page registry, the pairing screens, the welcome
// screen, first-run and update dialogs, the tour, the window's keyboard,
// opening workspace files and URLs, the workspace contexts and views, and the
// e2e harness.
//
// A window mounts <Sidebar/>, <ClientOverlays/> and (with no workspace)
// <WelcomePage/> inside <WorkspaceScope/>, calls useShortcuts(),
// registerWorkspaceViews() and startClientUi() once. The shell installs the
// client app, the UI state store and, on desktop, the desktop port first.

export { startClientUi } from './start'
export { installClientApp, clientApp, tryClientApp, type ClientApp } from './app'
export {
  installDesktopPort,
  desktopPort,
  useDesktopPort,
  subscribeDesktopPort,
  track,
  type DesktopPort,
  type UpdateStatus,
  type UpdateState,
  type FeedbackPrompt,
  type MenuItem,
} from './desktop'

// State.
export { useUIStore, selectedWorkspaceId, type UIStore, type UIState, type OverlayRequest } from './state/uiStore'
export {
  createUiStateStore,
  installUiState,
  uiState,
  useUiState,
  setUiState,
  normalizeUiState,
  UI_STATE_DOCUMENT,
  TELEMETRY_NOTICE_VERSION,
  DEFAULT_UI_STATE,
  type UiStateStore,
  type UiStateValues,
  type UiStateSnapshot,
  type ScreenCorner,
} from './state/uiState'
export { useTerminalStatuses, terminalStatuses, panelsWithPorts, terminalCwd } from './state/statusStore'
export { WindowIdContext, useWindowId } from './state/windowContext'

// Navigation and actions.
export {
  selectWorkspace,
  openLocalFolder,
  pickAndOpenFolder,
  closeWorkspace,
  cycleWorkspace,
  revealPanel,
  closePanels,
  renamePanel,
  detachPanel,
  openUrl,
  installNavigationHooks,
} from './navigation'
export { runWindowAction, windowActionContext } from './actions/run'
export { useShortcuts, registerKeyHandler, shouldRunShortcut, keyContext, isTextSurfaceFocused, type KeyHandler, type KeyContext } from './actions/useShortcuts'

// Views.
export { ClientOverlays, OverlayHost, registerOverlay, hasOverlay, type OverlayViewProps, type ClientOverlaysProps } from './overlays'
export { CommandPalette } from './palette/CommandPalette'
export { Sidebar, type SidebarProps, type SidebarOverlayButton } from './sidebar/Sidebar'
export { WorkspaceList } from './sidebar/WorkspaceList'
export { WorkspaceRow, WorkspacePanelRow } from './sidebar/WorkspaceRow'
export { workspacePanelTree, sortByWorktree, type WorkspacePanelTree, type WindowTree, type CanvasGroup } from './sidebar/panelTree'
export { ConnectionNotice, WorkspaceToggle } from './sidebar/connectionStatus'
export { WelcomePage } from './chrome/WelcomePage'
export { OverlayHeader, LeftSidebarReopen, useLeftChromeInset, useWindowControlsInset } from './chrome/chrome'
export { CateLogo } from './chrome/CateLogo'
export { UpdateButton } from './chrome/UpdateButton'
export { WelcomeDialog } from './dialogs/WelcomeDialog'
export { UpdateReadyDialog } from './dialogs/UpdateReadyDialog'
export { PostUpdateFeedbackDialog } from './dialogs/PostUpdateFeedbackDialog'
export { AnimatedDotGrid } from './dialogs/AnimatedDotGrid'
export { OnboardingTour } from './onboarding/OnboardingTour'
export { ONBOARDING_STEPS, type OnboardingStep } from './onboarding/steps'

// Workspace: opening files, the contexts workspace UI reads, and the
// workspace views registered into other modules' slots.
export { openFile, openDroppedFiles } from './workspace/fileActions'
export { FileViewsHost, WorkspaceScope, installReviewOpener, type ReviewOpener } from './workspace/hosts'
export { ConnectionBlocker, useWorkspaceBlock } from './workspace/ConnectionBlocker'
export { registerWorkspaceViews } from './workspace/views'

// Settings.
export { SettingsWindow, type SettingsWindowProps } from './settings/SettingsWindow'
export {
  registerSettingsPage,
  settingsPages,
  useSettingsPages,
  visiblePages,
  SETTINGS_GROUPS,
  type SettingsPage,
  type SettingsPageProps,
  type SettingsGroup,
} from './settings/registry'
export { DEFAULT_SETTINGS_PAGES, registerDefaultSettingsPages } from './settings/defaultPages'
export { installBuiltinWallpapers, BUILTIN_WALLPAPER_PREFIX, type BuiltinWallpaper } from './settings/pages/CanvasPage'

// Pairing.
export { JoinWorkspaceDialog } from './pairing/JoinWorkspaceDialog'
export { DevicesPage, AddDevice, PairedDevices } from './pairing/DevicesPage'

// Notifications (display of runtime notification events).
export * from './notifications'

// E2E.
export { installE2eHarness, createClientE2E, type ClientE2E, type CanvasE2EHooks } from './e2e/e2eHarness'
