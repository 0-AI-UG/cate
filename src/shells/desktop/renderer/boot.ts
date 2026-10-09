// Mounting the client in a desktop window (architecture 15): every slot the
// client, panels and services own gets its desktop implementation here, in
// dependency order, before the first render. The main window and detached
// windows boot the same client; a detached window shows one document window
// of one workspace.

import * as Sentry from '@sentry/electron/renderer'
import { createLogger, installLogSink, type LogSink } from '@kernel/log/contract'
import { createElectronRendererSink } from '@kernel/log/desktop/renderer'
import { createClientSettingsStore, type ClientSettingsStore } from '@kernel/settings/client'
import { clientSettingsTable } from '../settings'
import { installClientSettings, workspaceSettingsFor } from '../ui/kernel/settings'
import { applyTheme, applyUiScale, installAppearanceHost, installErrorReporter } from '../ui/kernel/interaction'
import { createShortcutRegistry, installClientUi, installShortcutRegistry } from '@kernel/interaction'
import type { NotificationAction } from '@kernel/interaction/contract'
import { eachConnection, type WorkspaceConnections } from '@client/connections'
import { startClientCore } from '@client/core'
import { documentStoreFor, setClientAttentive } from '@client/document'
import { PANEL_DEFINITIONS } from '@panels/definitions'
import {
  BUILTIN_WALLPAPERS,
  createCanvasE2E,
  installCanvasBackgroundPort,
  installCanvasRelationHost,
  installCanvasSettings,
  installScreenshotPort,
} from '../ui/client/layout/canvas'
import { canDetach, domDropEnvironment, installDragShell, installGestureLockWatchdog, setupCrossWindowDrops } from '../ui/client/layout/drag'
import { installWindowReveal, installWindowsPort, syncDetachedWindows } from '../ui/client/layout/windows'
import { onAgentsWorking } from '@services/agents/client'
import { attachNotifications } from '@workspace/notifications/client'
import {
  createNotificationDisplay,
  createUiStateStore,
  installClientApp,
  installDesktopPort,
  installBuiltinWallpapers,
  installE2eHarness,
  installUiState,
  openLocalFolder,
  openUrl,
  runNotificationAction,
  selectWorkspace,
  startClientUi,
  TELEMETRY_NOTICE_VERSION,
  useUIStore,
} from '../ui/app'
import type { WorkspaceList } from '@client/workspaces'
import { installEditorSettings, startFilesTreeOnOpen } from '../ui/panels/editor'
import { installTerminalViewSettings } from '../ui/panels/terminal'
import { RUNTIME_BUILD } from '@runtime/daemon/contract'
import type { BrowserPageBridge } from '@services/browser/contract'
import type { BootSnapshot, DesktopApi, DesktopAppInfo } from '../contract'
import { createDesktopClientUi } from './clientUi'
import { createDesktopPort } from './desktopPort'
import { createDragShell } from './drag'
import { quitBlockers } from './quitBlockers'
import { registerDesktopRenderer } from './registrations'
import { createScreenshotPort } from './screenshots'
import { createDesktopShellTransports, serveLoopbackRequests } from './transports'
import { installWebviewHosts, prepareWebviewPartitions, serveBrowserCodeCells, type WebviewPartitions } from './webviews'
import { attachDetachedWindow, createWindowsPort } from './windows'
import { RUNTIME_CAPABILITIES } from '@panels/capabilities'
import { restartStaleLocalRuntimes } from './staleRuntimes'

const log = createLogger('renderer')

type DesktopWindow =
  | { kind: 'main' }
  | { kind: 'detached'; workspaceId: string; windowId: string }

export interface DesktopClient {
  api: DesktopApi
  info: DesktopAppInfo
  window: DesktopWindow
  settings: ClientSettingsStore
  connections: WorkspaceConnections
  workspaces: WorkspaceList
  partitions: WebviewPartitions
  dispose(): void
}

export interface BootOptions {
  /** `window.cateBrowserPage` in the app. */
  pageBridge?: BrowserPageBridge
  /** Defaults to the electron-log renderer sink. */
  logSink?: LogSink
  /** Crash reporting; Sentry in the app. */
  reportError?: (error: unknown, context?: Record<string, unknown>) => void
}

function windowOf(info: DesktopAppInfo): DesktopWindow {
  const { kind, workspaceId, windowId } = info.window
  return kind === 'detached' && workspaceId && windowId ? { kind, workspaceId, windowId } : { kind: 'main' }
}

export async function bootDesktopClient(api: DesktopApi, options: BootOptions = {}): Promise<DesktopClient> {
  const stops: (() => void)[] = []

  // Logging, then the device: settings, appearance, shortcuts, crash reports.
  installLogSink(options.logSink ?? createElectronRendererSink())
  const info = await api.app.info()
  const window = windowOf(info)
  log.info('Renderer starting (window %s)', window.kind)
  const device = api.device

  const settings = createClientSettingsStore(device, clientSettingsTable)
  await settings.load()
  installClientSettings(settings)

  installAppearanceHost({
    themeSettings: () => ({
      customThemes: settings.get('customThemes'),
      systemDarkThemeId: settings.get('systemDarkThemeId'),
      systemLightThemeId: settings.get('systemLightThemeId'),
    }),
    // Main keeps the theme boot cache in boot.json from these same settings.
    setUiScale: (scale) => api.window.setZoomFactor(scale),
  })
  applyTheme(settings.get('activeThemeId'))
  applyUiScale(settings.get('uiScale'))
  stops.push(settings.subscribe((_values, patch) => {
    if ('activeThemeId' in patch || 'customThemes' in patch || 'systemDarkThemeId' in patch || 'systemLightThemeId' in patch) {
      applyTheme(settings.get('activeThemeId'))
    }
    if ('uiScale' in patch) applyUiScale(settings.get('uiScale'))
  }))
  installShortcutRegistry(createShortcutRegistry(settings))
  if (options.reportError) {
    const report = options.reportError
    installErrorReporter((error, context) => report(error, context))
  }

  // The client core: identity, connections, documents, sessions, page
  // operations, the workspace list.
  const transports = createDesktopShellTransports(api)
  const core = await startClientCore({
    device: info.device,
    features: info.features,
    deviceStore: device,
    transports,
    version: info.version,
    build: RUNTIME_BUILD,
    panels: PANEL_DEFINITIONS,
    capabilities: RUNTIME_CAPABILITIES,
  })
  const { identity, connections, workspaces } = core
  stops.push(api.app.onAttention(setClientAttentive))
  const partitions = prepareWebviewPartitions(api, connections)
  stops.push(() => partitions.dispose())
  stops.push(serveLoopbackRequests((runtimeId) => {
    const workspaceId = partitions.workspaceOf(runtimeId)
    return workspaceId ? connections.get(workspaceId) : undefined
  }, api))

  installClientApp({ workspaces, connections, version: info.version, build: RUNTIME_BUILD, pair: transports.pair, ssh: api.ssh })
  stops.push(restartStaleLocalRuntimes({ connections, workspaces, version: info.version, build: RUNTIME_BUILD }))
  installDesktopPort(createDesktopPort(api, info))
  const uiState = createUiStateStore(device)
  await uiState.load()
  // The first-run notice and the onboarding tour would cover what e2e specs
  // drive; each e2e launch is a fresh userData, so mark both as seen.
  if (info.e2e) {
    if (uiState.getSnapshot().telemetryNoticeAcknowledgedVersion < TELEMETRY_NOTICE_VERSION) {
      uiState.set('telemetryNoticeAcknowledgedVersion', TELEMETRY_NOTICE_VERSION)
    }
    if (!uiState.getSnapshot().onboardingCompleted) uiState.set('onboardingCompleted', true)
  }
  installUiState(uiState)
  installClientUi(createDesktopClientUi(api, info.features))
  stops.push(startClientUi())

  // Notifications: OS notifications with `osNotifications`, else toasts.
  const display = createNotificationDisplay({ settings })
  stops.push(
    attachNotifications(connections, display.show),
    onAgentsWorking(connections, display.cancel),
    () => display.dispose(),
  )
  stops.push(api.os.onNotificationAction((action) => {
    if (action && typeof action === 'object') runNotificationAction(action as NotificationAction)
  }))

  // Panels, their views and settings, and everything registered into slots.
  stops.push(registerDesktopRenderer(api))
  installTerminalViewSettings(settings)
  installEditorSettings(settings)
  stops.push(startFilesTreeOnOpen())

  // Canvas.
  installCanvasSettings({ client: settings, workspace: workspaceSettingsFor })
  stops.push(installCanvasRelationHost())
  installBuiltinWallpapers(BUILTIN_WALLPAPERS)
  installCanvasBackgroundPort({
    pickImage: () => api.dialogs.pickCanvasBackground(),
    readImage: (path) => api.dialogs.readCanvasBackground(path),
  })
  if (identity.features.has('screenCapture')) installScreenshotPort(createScreenshotPort(api))

  // Drags across windows, and detached windows.
  const dragShell = createDragShell(api, () => settings.get('snapToGrid'))
  stops.push(installDragShell(dragShell))
  stops.push(installGestureLockWatchdog())
  if (dragShell.crossWindow) stops.push(setupCrossWindowDrops(dragShell.crossWindow, () => domDropEnvironment(canDetach)))
  stops.push(installWindowReveal())
  if (identity.features.has('windows')) {
    const port = createWindowsPort(api)
    installWindowsPort(port)
    if (window.kind === 'main') {
      stops.push(eachConnection(connections, (connection) => {
        if (!documentStoreFor(connection.workspaceId)) return () => {}
        return syncDetachedWindows(connection.workspaceId, port)
      }))
    }
  }

  // Webviews: partitions before any guest mounts, then page operations.
  const bridge = options.pageBridge
  stops.push(installWebviewHosts(api, partitions, bridge))
  if (bridge && identity.features.has('pageDriver')) stops.push(serveBrowserCodeCells(connections, bridge))

  quitBlockers.install((labels) => api.app.setQuitBlockers(labels))
  if (info.e2e) stops.push(installE2eHarness({ canvas: createCanvasE2E() }))

  if (window.kind === 'detached') {
    await workspaces.open(window.workspaceId).catch((err: unknown) => log.warn('detached window: %s', err))
    useUIStore.getState().setSelectedWorkspace(window.workspaceId)
    stops.push(attachDetachedWindow(api, window.workspaceId, window.windowId))
  } else {
    await restoreLastWorkspace(api)
    stops.push(rememberSelectedWorkspace(api))
    // Paths opened with the app (Finder, dock, argv) open as local workspaces.
    stops.push(api.app.onOpenPath((path) => { void openLocalFolder(path) }))
    stops.push(api.app.onOpenUrl(openUrl))
    api.app.openRequestsReady()
  }

  return {
    api,
    info,
    window,
    settings,
    connections,
    workspaces,
    partitions,
    dispose() {
      for (const stop of stops.splice(0).reverse()) {
        try { stop() } catch { /* keep disposing */ }
      }
      core.dispose()
      uiState.dispose()
      settings.dispose()
    },
  }
}

async function restoreLastWorkspace(api: DesktopApi): Promise<void> {
  const boot = (await api.device.get('boot').catch(() => null)) as BootSnapshot | null
  const last = boot?.lastWorkspace
  if (last) void selectWorkspace(last)
}

function rememberSelectedWorkspace(api: DesktopApi): () => void {
  let last = useUIStore.getState().selectedWorkspaceId
  return useUIStore.subscribe((state) => {
    if (state.selectedWorkspaceId === last) return
    last = state.selectedWorkspaceId
    if (!last) return
    void (async () => {
      const boot = ((await api.device.get('boot').catch(() => null)) ?? {}) as BootSnapshot
      await api.device.set('boot', { ...boot, lastWorkspace: last })
    })().catch(() => {})
  })
}

declare const __SENTRY_DSN__: string

/** Sentry in the renderer rides main's instance over IPC. Main starts it only
 *  when the build carries a DSN, so without one this stays off. */
export function initRendererSentry(): (error: unknown, context?: Record<string, unknown>) => void {
  const dsn = typeof __SENTRY_DSN__ === 'string' ? __SENTRY_DSN__ : ''
  if (!dsn) return () => {}
  try { Sentry.init({}) } catch { /* reporting never blocks the app */ }
  return (error, context) => {
    try { Sentry.captureException(error, context ? { extra: context } : undefined) } catch { /* best effort */ }
  }
}
